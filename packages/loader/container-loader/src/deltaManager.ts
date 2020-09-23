/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { IEventProvider } from "@fluidframework/common-definitions";
import {
    IConnectionDetails,
    IDeltaHandlerStrategy,
    IDeltaManager,
    IDeltaManagerEvents,
    IDeltaQueue,
    ICriticalContainerError,
} from "@fluidframework/container-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import {
    IDocumentDeltaStorageService,
    IDocumentDeltaService,
} from "@fluidframework/driver-definitions";
import { isSystemType, isSystemMessage } from "@fluidframework/protocol-base";
import {
    ConnectionMode,
    IDocumentMessage,
    IDocumentSystemMessage,
    INack,
    ISequencedDocumentMessage,
    ISignalMessage,
    MessageType,
} from "@fluidframework/protocol-definitions";
import { CreateContainerError } from "@fluidframework/container-utils";
import { DeltaConnection } from "./deltaConnection";
import { DeltaQueue } from "./deltaQueue";
import { waitForConnectedState } from "./networkUtils";

const MaxReconnectDelaySeconds = 8;
const InitialReconnectDelaySeconds = 1;
const MissingFetchDelaySeconds = 0.1;
const MaxFetchDelaySeconds = 10;
const MaxBatchDeltas = 2000;

// Test if we deal with NetworkError object and if it has enough information to make a call.
// If in doubt, allow retries.
const canRetryOnError = (error: any): boolean => error?.canRetry !== false;
const getRetryDelayFromError = (error: any): number | undefined => error?.retryAfterSeconds;

export interface IConnectionArgs {
    mode?: ConnectionMode;
    fetchOpsFromStorage?: boolean;
    reason?: string;
}

export enum ReconnectMode {
    Never = "Never",
    Disabled = "Disabled",
    Enabled = "Enabled",
}

/**
 * Includes events emitted by the concrete implementation DeltaManager
 * but not exposed on the public interface IDeltaManager
 */
export interface IDeltaManagerInternalEvents extends IDeltaManagerEvents {
    (event: "closed", listener: (error?: ICriticalContainerError) => void);
}

/**
 * Manages the flow of both inbound and outbound messages. This class ensures that shared objects receive delta
 * messages in order regardless of possible network conditions or timings causing out of order delivery.
 */
export class DeltaManager
    extends TypedEventEmitter<IDeltaManagerInternalEvents>
    implements
    IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
    IEventProvider<IDeltaManagerInternalEvents>
{
    private pending: ISequencedDocumentMessage[] = [];
    private fetching = false;

    private updateSequenceNumberTimer: ReturnType<typeof setTimeout> | undefined;

    // The minimum sequence number and last sequence number received from the server
    private minSequenceNumber: number = 0;

    // There are three numbers we track
    // * lastQueuedSequenceNumber is the last queued sequence number. If there are gaps in seq numbers, then this number
    //   is not updated until we cover that gap, so it increases each time by 1.
    // * lastProcessedSequenceNumber - last processed sequence number
    private lastQueuedSequenceNumber: number = 0;
    private lastProcessedSequenceNumber: number = 0;

    private readonly _inbound: DeltaQueue<ISequencedDocumentMessage>;
    private readonly _inboundSignal: DeltaQueue<ISignalMessage>;
    private readonly _outbound: DeltaQueue<IDocumentMessage[]>;

    private connectionP: Promise<IConnectionDetails> | undefined;
    private connection: DeltaConnection | undefined;
    private clientSequenceNumber = 0;
    private clientSequenceNumberObserved = 0;

    // track clientId used last time when we sent any ops
    private lastSubmittedClientId: string | undefined;

    private handler: IDeltaHandlerStrategy | undefined;

    private messageBuffer: IDocumentMessage[] = [];

    public get inbound(): IDeltaQueue<ISequencedDocumentMessage> {
        return this._inbound;
    }

    public get outbound(): IDeltaQueue<IDocumentMessage[]> {
        return this._outbound;
    }

    public get inboundSignal(): IDeltaQueue<ISignalMessage> {
        return this._inboundSignal;
    }

    public get scopes(): string[] | undefined {
        return this.connection?.details.claims.scopes;
    }

    constructor(
        private readonly documentService: IDocumentDeltaService,
        private readonly deltaStorageService: IDocumentDeltaStorageService,
    ) {
        super();

        this._inbound = new DeltaQueue<ISequencedDocumentMessage>(
            (op) => {
                this.processInboundMessage(op);
            });

        // Outbound message queue. The outbound queue is represented as a queue of an array of ops. Ops contained
        // within an array *must* fit within the maxMessageSize and are guaranteed to be ordered sequentially.
        this._outbound = new DeltaQueue<IDocumentMessage[]>(
            (messages) => {
                if (this.connection === undefined) {
                    throw new Error("Attempted to submit an outbound message without connection");
                }
                this.connection.submit(messages);
            });

        // Inbound signal queue
        this._inboundSignal = new DeltaQueue<ISignalMessage>((message) => {
            if (this.handler === undefined) {
                throw new Error("Attempted to process an inbound signal without a handler attached");
            }
            this.handler.processSignal({
                clientId: message.clientId,
                content: JSON.parse(message.content as string),
            });
        });

        // Require the user to start the processing
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this._inbound.pause();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this._outbound.pause();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this._inboundSignal.pause();
    }

    /**
     * Sets the sequence number from which inbound messages should be returned
     */
    public attachOpHandler(handler: IDeltaHandlerStrategy) {
        this.lastProcessedSequenceNumber = 0;
        this.minSequenceNumber = 0;
        this.lastQueuedSequenceNumber = 0;

        // We will use same check in other places to make sure all the seq number above are set properly.
        assert(this.handler === undefined);
        this.handler = handler;
        assert(this.handler);

        this._inbound.systemResume();
        this._inboundSignal.systemResume();

        // We could have connected to delta stream before getting here
        // If so, it's time to process any accumulated ops
        // Or request OPs from snapshot / or point zero (if we have no ops at all)
        if (this.pending.length > 0) {
            this.catchUp([]);
        } else if (this.connection !== undefined || this.connectionP !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this.fetchMissingDeltas(this.lastQueuedSequenceNumber);
        }
    }

    public async connect(): Promise<IConnectionDetails> {
        if (this.connection !== undefined) {
            return this.connection.details;
        }

        if (this.connectionP !== undefined) {
            return this.connectionP;
        }

        const fetchOpsFromStorage = true;
        const requestedMode = "write";

        // Note: There is race condition here.
        // We want to issue request to storage as soon as possible, to
        // reduce latency of becoming current, thus this code here.
        // But there is no ordering between fetching OPs and connection to delta stream
        // As result, we might be behind by the time we connect to delta stream
        // In case of r/w connection, that's not an issue, because we will hear our
        // own "join" message and realize any gap client has in ops.
        // But for view-only connection, we have no such signal, and with no traffic
        // on the wire, we might be always behind.
        // See comment at the end of setupNewSuccessfulConnection()
        if (fetchOpsFromStorage && this.handler !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this.fetchMissingDeltas(this.lastQueuedSequenceNumber);
        }

        // The promise returned from connectCore will settle with a resolved DeltaConnection or reject with error
        const connectCore = async () => {
            let connection: DeltaConnection | undefined;
            let delay = InitialReconnectDelaySeconds;

            // This loop will keep trying to connect until successful, with a delay between each iteration.
            while (connection === undefined) {
                try {
                    connection = await DeltaConnection.connect(this.documentService);
                } catch (origError) {
                    const error = CreateContainerError(origError);

                    // Socket.io error when we connect to wrong socket, or hit some multiplexing bug
                    if (!canRetryOnError(origError)) {
                        throw error;
                    }

                    const retryDelayFromError = getRetryDelayFromError(origError);
                    delay = retryDelayFromError ?? Math.min(delay * 2, MaxReconnectDelaySeconds);

                    await waitForConnectedState(delay * 1000);
                }
            }

            this.setupNewSuccessfulConnection(connection, requestedMode);

            return connection;
        };

        // This promise settles as soon as we know the outcome of the connection attempt
        this.connectionP = new Promise((resolve, reject) => {
            // Regardless of how the connection attempt concludes, we'll clear the promise and remove the listener

            // Reject the connection promise if the DeltaManager gets closed during connection
            const cleanupAndReject = (error) => {
                this.connectionP = undefined;
                this.removeListener("closed", cleanupAndReject);
                reject(error);
            };
            this.on("closed", cleanupAndReject);

            // Attempt the connection
            connectCore().then((connection) => {
                this.connectionP = undefined;
                this.removeListener("closed", cleanupAndReject);
                resolve(connection.details);
            }).catch(cleanupAndReject);
        });

        return this.connectionP;
    }

    private flush() {
        if (this.messageBuffer.length === 0) {
            return;
        }

        this._outbound.push(this.messageBuffer);
        this.messageBuffer = [];
    }

    public submit(type: MessageType, contents: any): number {
        // reset clientSequenceNumber if we are using new clientId.
        // we keep info about old connection as long as possible to be able to account for all non-acked ops
        // that we pick up on next connection.
        assert(this.connection);
        if (this.lastSubmittedClientId !== this.connection?.details.clientId) {
            this.lastSubmittedClientId = this.connection?.details.clientId;
            this.clientSequenceNumber = 0;
            this.clientSequenceNumberObserved = 0;
        }

        const message: IDocumentMessage = {
            clientSequenceNumber: ++this.clientSequenceNumber,
            contents: JSON.stringify(contents),
            metadata: undefined,
            referenceSequenceNumber: this.lastProcessedSequenceNumber,
            type,
        };

        const outbound = this.createOutboundMessage(type, message);
        this.stopSequenceNumberUpdate();

        // Not batching
        this.flush();
        this.messageBuffer.push(outbound);
        this.flush();

        return outbound.clientSequenceNumber;
    }

    public submitSignal(content: any) {
        this.connection?.submitSignal(content);
    }

    public resume(): void {
        this.inbound.resume();
        this.outbound.resume();
        this.inboundSignal.resume();
    }

    private async getDeltas(
        fromInitial: number,
        to: number | undefined,
        callback: (messages: ISequencedDocumentMessage[]) => void) {
        let retry: number = 0;
        let from: number = fromInitial;
        let deltas: ISequencedDocumentMessage[] = [];

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const maxFetchTo = from + MaxBatchDeltas;
            const fetchTo = to === undefined ? maxFetchTo : Math.min(maxFetchTo, to);

            let deltasRetrievedLast = 0;
            let success = true;
            let canRetry = false;
            let retryAfter: number | undefined;

            try {
                // Issue async request for deltas - limit the number fetched to MaxBatchDeltas
                canRetry = true;
                const deltasP = this.deltaStorageService.get(from, fetchTo);

                // Return previously fetched deltas, for processing while we are waiting for new request.
                if (deltas.length > 0) {
                    callback(deltas);
                }

                // Now wait for request to come back
                deltas = await deltasP;

                // Note that server (or driver code) can push here something unexpected, like undefined
                // Exception thrown as result of it will result in us retrying
                deltasRetrievedLast = deltas.length;
                const lastFetch = deltasRetrievedLast > 0 ? deltas[deltasRetrievedLast - 1].sequenceNumber : from;

                // If we have no upper bound and fetched less than the max deltas - meaning we got as many as exit -
                // then we can resolve the promise. We also resolve if we fetched up to the expected to. Otherwise
                // we will look to try again
                // Note #1: we can get more ops than what we asked for - need to account for that!
                // Note #2: from & to are exclusive! I.e. we actually expect [from + 1, to - 1] range of ops back!
                // 1) to === undefined case: if last op  is below what we expect, then storage does not have
                //    any more, thus it's time to leave
                // 2) else case: if we got what we asked (to - 1) or more, then time to leave.
                if (to === undefined ? lastFetch < maxFetchTo - 1 : to - 1 <= lastFetch) {
                    callback(deltas);
                    return;
                }

                // Attempt to fetch more deltas. If we didn't receive any in the previous call we up our retry
                // count since something prevented us from seeing those deltas
                from = lastFetch;
            } catch (origError) {
                canRetry = canRetry && canRetryOnError(origError);

                if (!canRetry) {
                    return;
                }
                success = false;
                retryAfter = getRetryDelayFromError(origError);
            }

            let delay: number;
            if (deltasRetrievedLast !== 0) {
                delay = 0;
                retry = 0; // start calculating timeout over if we got some ops
            } else {
                retry++;
                delay = retryAfter ?? Math.min(MaxFetchDelaySeconds, MissingFetchDelaySeconds * Math.pow(2, retry));

                // Chances that we will get something from storage after that many retries is zero.
                // We wait 10 seconds between most of retries, so that's 16 minutes of waiting!
                // Note - it's very important that we differentiate connected state from possibly disconnected state!
                // Only bail out if we successfully connected to storage, but there were no ops
                // One (last) successful connection is sufficient, even if user was disconnected all prior attempts
                if (success && retry >= 100) {
                    return;
                }
            }

            await waitForConnectedState(delay * 1000);
        }
    }

    // Specific system level message attributes are need to be looked at by the server.
    // Hence they are separated and promoted as top level attributes.
    private createOutboundMessage(
        type: MessageType,
        coreMessage: IDocumentMessage): IDocumentMessage {
        if (isSystemType(type)) {
            const data = coreMessage.contents as string;
            coreMessage.contents = null;
            const outboundMessage: IDocumentSystemMessage = {
                ...coreMessage,
                data,
            };
            return outboundMessage;
        } else {
            return coreMessage;
        }
    }

    /**
     * Once we've successfully gotten a DeltaConnection, we need to set up state, attach event listeners, and process
     * initial messages.
     * @param connection - The newly established connection
     */
    private setupNewSuccessfulConnection(connection: DeltaConnection, requestedMode: ConnectionMode) {
        this.connection = connection;

        // We cancel all ops on lost of connectivity, and rely on DDSes to resubmit them.
        // Semantics are not well defined for batches (and they are broken right now on disconnects anyway),
        // but it's safe to assume (until better design is put into place) that batches should not exist
        // across multiple connections. Right now we assume runtime will not submit any ops in disconnected
        // state. As requirements change, so should these checks.
        assert(this.messageBuffer.length === 0, "messageBuffer is not empty on new connection");

        this._outbound.systemResume();

        connection.on("op", (documentId: string, messages: ISequencedDocumentMessage[]) => {
            if (messages instanceof Array) {
                this.enqueueMessages(messages);
            } else {
                this.enqueueMessages([messages]);
            }
        });

        connection.on("signal", (message: ISignalMessage) => {
            this._inboundSignal.push(message);
        });

        connection.on("nack", (documentId: string, messages: INack[]) => {
            console.error(`Got NACK'd: ${messages}`);
        });

        const initialMessages = connection.details.initialMessages;

        // Notify of the connection
        // WARNING: This has to happen before processInitialMessages() call below.
        // If not, we may not update Container.pendingClientId in time before seeing our own join session op.
        this.emit(
            "connect",
            connection.details,
            undefined,
        );

        this.processInitialMessages(
            initialMessages,
            connection.details.initialSignals ?? [],
        );

        // if we have some op on the wire (or will have a "join" op for ourselves for r/w connection), then client
        // can detect it has a gap and fetch missing ops. However if we are connecting as view-only, then there
        // is no good signal to realize if client is behind. Thus we have to hit storage to see if any ops are there.
        if (this.handler !== undefined && connection.details.mode !== "write" && initialMessages.length === 0) {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this.fetchMissingDeltas(this.lastQueuedSequenceNumber);
        }
    }

    private processInitialMessages(
        messages: ISequencedDocumentMessage[],
        signals: ISignalMessage[],
    ): void {
        if (messages.length > 0) {
            this.catchUp(messages);
        }
        for (const signal of signals) {
            this._inboundSignal.push(signal);
        }
    }

    private enqueueMessages(messages: ISequencedDocumentMessage[]): void {
        if (this.handler === undefined) {
            // We did not setup handler yet.
            // This happens when we connect to web socket faster than we get attributes for container
            // and thus faster than attachOpHandler() is called
            // this.lastProcessedSequenceNumber is still zero, so we can't rely on this.fetchMissingDeltas()
            // to do the right thing.
            this.pending = this.pending.concat(messages);
            return;
        }

        let duplicateStart: number | undefined;
        let duplicateEnd: number | undefined;

        for (const message of messages) {
            // Check that the messages are arriving in the expected order
            if (message.sequenceNumber <= this.lastQueuedSequenceNumber) {
                if (duplicateStart === undefined || duplicateStart > message.sequenceNumber) {
                    duplicateStart = message.sequenceNumber;
                }
                if (duplicateEnd === undefined || duplicateEnd < message.sequenceNumber) {
                    duplicateEnd = message.sequenceNumber;
                }
            } else if (message.sequenceNumber !== this.lastQueuedSequenceNumber + 1) {
                this.pending.push(message);
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                this.fetchMissingDeltas(this.lastQueuedSequenceNumber, message.sequenceNumber);
            } else {
                this.lastQueuedSequenceNumber = message.sequenceNumber;
                this._inbound.push(message);
            }
        }
    }

    private processInboundMessage(message: ISequencedDocumentMessage): void {
        // All non-system messages are coming from some client, and should have clientId
        // System messages may have no clientId (but some do, like propose, noop, summarize)
        // Note: NoClient has not been added yet to isSystemMessage (in 0.16.x branch)
        assert(
            message.clientId !== undefined
            || isSystemMessage(message)
            || message.type === MessageType.NoClient,
            "non-system message have to have clientId",
        );

        // if we have connection, and message is local, then we better treat is as local!
        assert(
            this.connection === undefined
            || this.connection.details.clientId !== message.clientId
            || this.lastSubmittedClientId === message.clientId,
            "Not accounting local messages correctly",
        );

        if (this.lastSubmittedClientId !== undefined && this.lastSubmittedClientId === message.clientId) {
            const clientSequenceNumber = message.clientSequenceNumber;

            assert(this.clientSequenceNumberObserved < clientSequenceNumber, "client seq# not growing");
            assert(clientSequenceNumber <= this.clientSequenceNumber,
                "Incoming local client seq# > generated by this client");

            this.clientSequenceNumberObserved = clientSequenceNumber;
        }

        // TODO Remove after SPO picks up the latest build.
        if (
            typeof message.contents === "string"
            && message.contents !== ""
            && message.type !== MessageType.ClientLeave
        ) {
            message.contents = JSON.parse(message.contents);
        }

        // Watch the minimum sequence number and be ready to update as needed
        assert(this.minSequenceNumber <= message.minimumSequenceNumber, "msn moves backwards");
        this.minSequenceNumber = message.minimumSequenceNumber;

        assert.equal(message.sequenceNumber, this.lastProcessedSequenceNumber + 1, "non-seq seq#");
        this.lastProcessedSequenceNumber = message.sequenceNumber;

        // Back-compat for older server with no term
        if (message.term === undefined) {
            message.term = 1;
        }

        if (this.handler === undefined) {
            throw new Error("Attempted to process an inbound message without a handler attached");
        }
        this.handler.process(message);
    }

    /**
     * Retrieves the missing deltas between the given sequence numbers
     */
    private async fetchMissingDeltas(from: number, to?: number): Promise<void> {
        // Exit out early if we're already fetching deltas
        if (this.fetching) {
            return;
        }

        this.fetching = true;

        await this.getDeltas(from, to, (messages) => {
            this.catchUpCore(messages);
        });

        this.fetching = false;
    }

    private catchUp(messages: ISequencedDocumentMessage[]): void {
        const props: {
            eventName: string;
            messageCount: number;
            pendingCount: number;
            from?: number;
            to?: number;
            messageGap?: number;
        } = {
            eventName: `CatchUp`,
            messageCount: messages.length,
            pendingCount: this.pending.length,
        };
        if (messages.length !== 0) {
            props.from = messages[0].sequenceNumber;
            props.to = messages[messages.length - 1].sequenceNumber;
            props.messageGap = this.handler !== undefined ? props.from - this.lastQueuedSequenceNumber - 1 : undefined;
        }

        this.catchUpCore(messages);
    }

    private catchUpCore(messages: ISequencedDocumentMessage[]): void {
        // Apply current operations
        this.enqueueMessages(messages);

        // Then sort pending operations and attempt to apply them again.
        // This could be optimized to stop handling messages once we realize we need to fetch missing values.
        // But for simplicity, and because catching up should be rare, we just process all of them.
        // Optimize for case of no handler - we put ops back into this.pending in such case
        if (this.handler !== undefined) {
            const pendingSorted = this.pending.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
            this.pending = [];
            this.enqueueMessages(pendingSorted);
        }
    }

    private stopSequenceNumberUpdate(): void {
        if (this.updateSequenceNumberTimer !== undefined) {
            clearTimeout(this.updateSequenceNumberTimer);
        }
        this.updateSequenceNumberTimer = undefined;
    }
}
