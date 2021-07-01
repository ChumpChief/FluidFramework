/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { default as AbortController } from "abort-controller";
import { v4 as uuid } from "uuid";
import { ITelemetryLogger, IEventProvider } from "@fluidframework/common-definitions";
import {
    IConnectionDetails,
    IDeltaHandlerStrategy,
    IDeltaManager,
    IDeltaManagerEvents,
    IDeltaQueue,
    ICriticalContainerError,
    ContainerErrorType,
    IThrottlingWarning,
    ReadOnlyInfo,
} from "@fluidframework/container-definitions";
import { assert, TypedEventEmitter } from "@fluidframework/common-utils";
import { LoggingError } from "@fluidframework/telemetry-utils";
import {
    IDocumentDeltaStorageService,
    IDocumentService,
    DriverErrorType,
} from "@fluidframework/driver-definitions";
import { isSystemMessage } from "@fluidframework/protocol-base";
import {
    ConnectionMode,
    IClientConfiguration,
    IClientDetails,
    IDocumentMessage,
    ISequencedDocumentMessage,
    ISignalMessage,
    ITrace,
    MessageType,
} from "@fluidframework/protocol-definitions";
import {
    NonRetryableError,
} from "@fluidframework/driver-utils";
import {
    CreateContainerError,
    CreateProcessingError,
    DataCorruptionError,
} from "@fluidframework/container-utils";
import { DeltaQueue } from "./deltaQueue";
import { StatefulDocumentDeltaConnection } from "./statefulDocumentDeltaConnection";

export interface IConnectionArgs {
    mode?: ConnectionMode;
    fetchOpsFromStorage?: boolean;
    reason: string;
}

/**
 * Includes events emitted by the concrete implementation DeltaManager
 * but not exposed on the public interface IDeltaManager
 */
export interface IDeltaManagerInternalEvents extends IDeltaManagerEvents {
    (event: "throttled", listener: (error: IThrottlingWarning) => void);
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
    public get active(): boolean { return this._active(); }

    public get disposed() { return this.closed; }

    public get clientDetails(): IClientDetails {
        throw new Error("Not implemented");
    }
    public get IDeltaSender() { return this; }

    private pending: ISequencedDocumentMessage[] = [];
    private fetchReason: string | undefined;

    // The minimum sequence number and last sequence number received from the server
    private minSequenceNumber: number = 0;

    // There are three numbers we track
    // * lastQueuedSequenceNumber is the last queued sequence number. If there are gaps in seq numbers, then this number
    //   is not updated until we cover that gap, so it increases each time by 1.
    // * lastObservedSeqNumber is  an estimation of last known sequence number for container in storage. It's initially
    //   populated at web socket connection time (if storage provides that info) and is  updated once ops shows up.
    //   It's never less than lastQueuedSequenceNumber
    // * lastProcessedSequenceNumber - last processed sequence number
    private lastQueuedSequenceNumber: number = 0;
    private lastObservedSeqNumber: number = 0;
    private lastProcessedSequenceNumber: number = 0;
    private lastProcessedMessage: ISequencedDocumentMessage | undefined;
    private baseTerm: number = 0;

    private previouslyProcessedMessage: ISequencedDocumentMessage | undefined;

    // The sequence number we initially loaded from
    private initSequenceNumber: number = 0;

    private readonly _inbound: DeltaQueue<ISequencedDocumentMessage>;
    private readonly _inboundSignal: DeltaQueue<ISignalMessage>;
    private readonly _outbound: DeltaQueue<IDocumentMessage[]>;

    private clientSequenceNumber = 0;
    private clientSequenceNumberObserved = 0;
    // Counts the number of noops sent by the client which may not be acked.
    private trailingNoopCount = 0;
    private closed = false;
    private readonly deltaStorageDelayId = uuid();

    // track clientId used last time when we sent any ops
    private lastSubmittedClientId: string | undefined;

    private handler: IDeltaHandlerStrategy | undefined;
    private deltaStorage: IDocumentDeltaStorageService | undefined;

    private messageBuffer: IDocumentMessage[] = [];

    private connectFirstConnection = true;
    private readonly throttlingIdSet = new Set<string>();
    private timeTillThrottling: number = 0;

    private readonly closeAbortController = new AbortController();

    public get hasCheckpointSequenceNumber(): boolean {
        throw new Error("Not implemented");
    }

    public get inbound(): IDeltaQueue<ISequencedDocumentMessage> {
        return this._inbound;
    }

    public get outbound(): IDeltaQueue<IDocumentMessage[]> {
        return this._outbound;
    }

    public get inboundSignal(): IDeltaQueue<ISignalMessage> {
        return this._inboundSignal;
    }

    public get initialSequenceNumber(): number {
        return this.initSequenceNumber;
    }

    public get lastSequenceNumber(): number {
        return this.lastProcessedSequenceNumber;
    }

    public get lastMessage() {
        return this.lastProcessedMessage;
    }

    public get lastKnownSeqNumber() {
        return this.lastObservedSeqNumber;
    }

    public get referenceTerm(): number {
        return this.baseTerm;
    }

    public get minimumSequenceNumber(): number {
        return this.minSequenceNumber;
    }

    public get maxMessageSize(): number {
        return this.statefulDocumentDeltaConnection.maxMessageSize;
    }

    public get version(): string {
        throw new Error("Not implemented");
    }

    public get serviceConfiguration(): IClientConfiguration | undefined {
        return this.statefulDocumentDeltaConnection.connected
            ? this.statefulDocumentDeltaConnection.serviceConfiguration
            : undefined;
    }

    /**
     * Tells if container is in read-only mode.
     * Data stores should listen for "readonly" notifications and disallow user
     * making changes to data stores.
     * Readonly state can be because of no storage write permission,
     * or due to host forcing readonly mode for container.
     * It is undefined if we have not yet established websocket connection
     * and do not know if user has write access to a file.
     * @deprecated - use readOnlyInfo
     */
    public get readonly() {
        return this.statefulDocumentDeltaConnection.connected
            ? this.statefulDocumentDeltaConnection.readonlyScope
            : true;
    }

    /**
     * Tells if user has no write permissions for file in storage
     * It is undefined if we have not yet established websocket connection
     * and do not know if user has write access to a file.
     * @deprecated - use readOnlyInfo
     */
    public get readonlyPermissions() {
        throw new Error("Not implemented");
    }

    public get readOnlyInfo(): ReadOnlyInfo {
        throw new Error("Not implemented");
    }

    public expectingAcks(): boolean {
        // We don't have to wait for ack for topmost NoOps. So subtract those.
        return this.clientSequenceNumberObserved < (this.clientSequenceNumber - this.trailingNoopCount);
    }

    constructor(
        private readonly serviceProvider: () => Pick<IDocumentService, "connectToDeltaStorage"> | undefined,
        private readonly statefulDocumentDeltaConnection: StatefulDocumentDeltaConnection,
        private readonly logger: ITelemetryLogger,
        private readonly _active: () => boolean,
    ) {
        super();

        this._inbound = new DeltaQueue<ISequencedDocumentMessage>(
            (op) => {
                this.processInboundMessage(op);
            });

        this._inbound.on("error", (error) => {
            this.close(CreateProcessingError(error, this.lastMessage));
        });

        // Outbound message queue. The outbound queue is represented as a queue of an array of ops. Ops contained
        // within an array *must* fit within the maxMessageSize and are guaranteed to be ordered sequentially.
        this._outbound = new DeltaQueue<IDocumentMessage[]>(
            (messages) => {
                if (!this.statefulDocumentDeltaConnection.connected) {
                    throw new Error("Attempted to submit an outbound message without connection");
                }
                this.statefulDocumentDeltaConnection.submit(messages);
            });

        this._outbound.on("error", (error) => {
            this.close(CreateContainerError(error));
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

        this._inboundSignal.on("error", (error) => {
            this.close(CreateContainerError(error));
        });

        this.statefulDocumentDeltaConnection.on("op", this.opHandler);
        this.statefulDocumentDeltaConnection.on("signal", this.signalHandler);
        this.statefulDocumentDeltaConnection.on("connected", this.connectedHandler);
        this.statefulDocumentDeltaConnection.on("disconnected", this.disconnectedHandler);

        // Initially, all queues are created paused.
        // - outbound is flipped back and forth in setupNewSuccessfulConnection / disconnectFromDeltaStream
        // - inbound & inboundSignal are resumed in attachOpHandler() when we have handler setup
    }

    public dispose() {
        throw new Error("Not implemented.");
    }

    /**
     * Sets the sequence number from which inbound messages should be returned
     */
    public attachOpHandler(
        minSequenceNumber: number,
        sequenceNumber: number,
        term: number,
        handler: IDeltaHandlerStrategy,
    ) {
        this.initSequenceNumber = sequenceNumber;
        this.lastProcessedSequenceNumber = sequenceNumber;
        this.baseTerm = term;
        this.minSequenceNumber = minSequenceNumber;
        this.lastQueuedSequenceNumber = sequenceNumber;
        this.lastObservedSeqNumber = sequenceNumber;

        // We will use same check in other places to make sure all the seq number above are set properly.
        assert(this.handler === undefined, 0x0e2 /* "DeltaManager already has attached op handler!" */);
        this.handler = handler;
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        assert(!!(this.handler as any), 0x0e3 /* "Newly set op handler is null/undefined!" */);

        this._inbound.resume();
        this._inboundSignal.resume();

        // We could have connected to delta stream before getting here
        // If so, it's time to process any accumulated ops, as there might be no other event that
        // will force these pending ops to be processed.
        // Or request OPs from snapshot / or point zero (if we have no ops at all)
        if (this.pending.length > 0) {
            this.processPendingOps("DocumentOpen");
        }
    }

    public async preFetchOps(cacheOnly: boolean) {
        // Note that might already got connected to delta stream by now.
        // If we did, then we proactively fetch ops at the end of setupNewSuccessfulConnection to ensure
        if (!this.statefulDocumentDeltaConnection.connected) {
            return this.fetchMissingDeltasCore("DocumentOpen", cacheOnly, this.lastQueuedSequenceNumber, undefined);
        }
    }

    public async connect(args: IConnectionArgs): Promise<IConnectionDetails> {
        throw new Error("Not implemented");
    }

    public flush() {
        if (this.messageBuffer.length === 0) {
            return;
        }

        // The prepareFlush event allows listeners to append metadata to the batch prior to submission.
        this.emit("prepareSend", this.messageBuffer);

        this._outbound.push(this.messageBuffer);
        this.messageBuffer = [];
    }

    /**
     * Submits the given delta returning the client sequence number for the message. Contents is the actual
     * contents of the message. appData is optional metadata that can be attached to the op by the app.
     *
     * If batch is set to true then the submit will be batched - and as a result guaranteed to be ordered sequentially
     * in the global sequencing space. The batch will be flushed either when flush is called or when a non-batched
     * op is submitted.
     */
    public submit(type: MessageType, contents: any, batch = false, metadata?: any): number {
        if (this.readonly === true) {
            const error = new LoggingError("Op is sent in read-only document state", {
                errorType: ContainerErrorType.genericError,
            });
            this.close(CreateContainerError(error));
            return -1;
        }

        // reset clientSequenceNumber if we are using new clientId.
        // we keep info about old connection as long as possible to be able to account for all non-acked ops
        // that we pick up on next connection.
        assert(this.statefulDocumentDeltaConnection.connected, 0x0e4 /* "Lost old connection!" */);
        const clientId = this.statefulDocumentDeltaConnection.connected
            ? this.statefulDocumentDeltaConnection.clientId
            : undefined;
        if (this.lastSubmittedClientId !== clientId) {
            this.lastSubmittedClientId = clientId;
            this.clientSequenceNumber = 0;
            this.clientSequenceNumberObserved = 0;
        }

        // Start adding trace for the op.
        const traces: ITrace[] = [
            {
                action: "start",
                service: "client",
                timestamp: Date.now(),
            }];

        const message: IDocumentMessage = {
            clientSequenceNumber: ++this.clientSequenceNumber,
            contents: JSON.stringify(contents),
            metadata,
            referenceSequenceNumber: this.lastProcessedSequenceNumber,
            traces,
            type,
        };

        if (type === MessageType.NoOp) {
            this.trailingNoopCount++;
        } else {
            this.trailingNoopCount = 0;
        }

        this.emit("submitOp", message);

        if (!batch) {
            this.flush();
            this.messageBuffer.push(message);
            this.flush();
        } else {
            this.messageBuffer.push(message);
        }

        return message.clientSequenceNumber;
    }

    public submitSignal(content: any) {
        if (this.statefulDocumentDeltaConnection.connected) {
            this.statefulDocumentDeltaConnection.submitSignal(content);
        } else {
            this.logger.sendErrorEvent({ eventName: "submitSignalDisconnected" });
        }
    }

    private async getDeltas(
        from: number, // inclusive
        to: number | undefined, // exclusive
        callback: (messages: ISequencedDocumentMessage[]) => void,
        cacheOnly: boolean)
    {
        const docService = this.serviceProvider();
        if (docService === undefined) {
            throw new Error("Delta manager is not attached");
        }

        if (this.deltaStorage === undefined) {
            this.deltaStorage = await docService.connectToDeltaStorage();
        }

        let controller = this.closeAbortController;
        let listenerToClear: ((op: ISequencedDocumentMessage) => void) | undefined;

        if (to !== undefined) {
            controller = new AbortController();

            assert(this.closeAbortController.signal.onabort === null, 0x1e8 /* "reentrancy" */);
            this.closeAbortController.signal.onabort = () => controller.abort();

            const listener = (op: ISequencedDocumentMessage) => {
                // Be prepared for the case where webSocket would receive the ops that we are trying to fill through
                // storage. Ideally it should never happen (i.e. ops on socket are always ordered, and thus once we
                // detected gap, this gap can't be filled in later on through websocket).
                // And in practice that does look like the case. The place where this code gets hit is if we lost
                // connection and reconnected (likely to another box), and new socket's initial ops contains these ops.
                if (op.sequenceNumber >= to) {
                    controller.abort();
                    this._inbound.off("push", listener);
                }
            };
            this._inbound.on("push", listener);
            listenerToClear = listener;
        }

        try {
            const stream = this.deltaStorage.fetchMessages(
                from, // inclusive
                to, // exclusive
                controller.signal,
                cacheOnly);

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const result = await stream.read();
                if (result.done) {
                    break;
                }
                callback(result.value);
            }
        } finally {
            this.closeAbortController.signal.onabort = null;
            if (listenerToClear !== undefined) {
                this._inbound.off("push", listenerToClear);
            }
        }
    }

    /**
     * Closes the connection and clears inbound & outbound queues.
     */
    public close(error?: ICriticalContainerError): void {
        if (this.closed) {
            return;
        }
        this.closed = true;

        this.statefulDocumentDeltaConnection.off("op", this.opHandler);
        this.statefulDocumentDeltaConnection.off("signal", this.signalHandler);
        this.statefulDocumentDeltaConnection.off("connected", this.connectedHandler);
        this.statefulDocumentDeltaConnection.off("disconnected", this.disconnectedHandler);

        this.closeAbortController.abort();

        this._inbound.clear();
        this._outbound.clear();
        this._inboundSignal.clear();

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this._inbound.pause();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this._inboundSignal.pause();

        // Drop pending messages - this will ensure catchUp() does not go into infinite loop
        this.pending = [];

        // This needs to be the last thing we do (before removing listeners), as it causes
        // Container to dispose context and break ability of data stores / runtime to "hear"
        // from delta manager, including notification (above) about readonly state.
        this.emit("closed", error);

        this.removeAllListeners();
    }

    public refreshDelayInfo(id: string) {
        this.throttlingIdSet.delete(id);
        if (this.throttlingIdSet.size === 0) {
            this.timeTillThrottling = 0;
        }
    }

    public emitDelayInfo(
        id: string,
        delayMs: number,
        error: ICriticalContainerError,
    ) {
        const timeNow = Date.now();
        this.throttlingIdSet.add(id);
        if (delayMs > 0 && (timeNow + delayMs > this.timeTillThrottling)) {
            this.timeTillThrottling = timeNow + delayMs;

            // Add 'throttling' properties to an error with safely extracted properties:
            const throttlingWarning: IThrottlingWarning = {
                errorType: ContainerErrorType.throttlingError,
                message: `Service busy/throttled: ${error.message}`,
                retryAfterSeconds: delayMs / 1000,
            };
            const reconfiguredError: IThrottlingWarning = {
                ...CreateContainerError(error),
                ...throttlingWarning,
            };
            this.emit("throttled", reconfiguredError);
        }
    }

    private readonly opHandler = (documentId: string, messagesArg: ISequencedDocumentMessage[]) => {
        const messages = Array.isArray(messagesArg) ? messagesArg : [messagesArg];
        this.enqueueMessages(messages, "opHandler");
    };

    private readonly signalHandler = (message: ISignalMessage) => {
        this._inboundSignal.push(message);
    };

    // TODO consider if we need this
    // private readonly connectingHandler = () => {
    //     this.fetchMissingDeltas(args.reason, this.lastQueuedSequenceNumber);
    // }

    private readonly connectedHandler = () => {
        // We cancel all ops on lost of connectivity, and rely on DDSes to resubmit them.
        // Semantics are not well defined for batches (and they are broken right now on disconnects anyway),
        // but it's safe to assume (until better design is put into place) that batches should not exist
        // across multiple connections. Right now we assume runtime will not submit any ops in disconnected
        // state. As requirements change, so should these checks.
        assert(this.messageBuffer.length === 0, 0x0e9 /* "messageBuffer is not empty on new connection" */);

        this._outbound.resume();

        // Initial messages are always sorted. However, due to early op handler installed by drivers and appending those
        // ops to initialMessages, resulting set is no longer sorted, which would result in client hitting storage to
        // fill in gap. We will recover by cancelling this request once we process remaining ops, but it's a waste that
        // we could avoid
        const initialMessages = this.statefulDocumentDeltaConnection.initialMessages.sort(
            (a, b) => a.sequenceNumber - b.sequenceNumber,
        );

        // Some storages may provide checkpointSequenceNumber to identify how far client is behind.
        const checkpointSequenceNumber = this.statefulDocumentDeltaConnection.checkpointSequenceNumber;
        if (checkpointSequenceNumber !== undefined) {
            this.updateLatestKnownOpSeqNumber(checkpointSequenceNumber);
        }

        // Update knowledge of how far we are behind, before raising "connect" event
        // This is duplication of what enqueueMessages() does, but we have to raise event before we get there,
        // so duplicating update logic here as well.
        const last = initialMessages.length > 0 ? initialMessages[initialMessages.length - 1].sequenceNumber : -1;
        if (initialMessages.length > 0) {
            this.updateLatestKnownOpSeqNumber(last);
        }

        const connectionDetails = {
            claims: this.statefulDocumentDeltaConnection.claims,
            clientId: this.statefulDocumentDeltaConnection.clientId,
            existing: this.statefulDocumentDeltaConnection.existing,
            checkpointSequenceNumber: this.statefulDocumentDeltaConnection.checkpointSequenceNumber,
            initialClients: this.statefulDocumentDeltaConnection.initialClients,
            maxMessageSize: this.statefulDocumentDeltaConnection.maxMessageSize,
            mode: this.statefulDocumentDeltaConnection.mode,
            serviceConfiguration: this.statefulDocumentDeltaConnection.serviceConfiguration,
            version: this.statefulDocumentDeltaConnection.version,
        };

        // Notify of the connection
        // WARNING: This has to happen before processInitialMessages() call below.
        // If not, we may not update Container.pendingClientId in time before seeing our own join session op.
        this.emit(
            "connect",
            connectionDetails,
        );

        this.enqueueMessages(
            initialMessages,
            this.connectFirstConnection ? "InitialOps" : "ReconnectOps");

        const initialSignals = this.statefulDocumentDeltaConnection.initialSignals;
        if (initialSignals !== undefined) {
            for (const signal of initialSignals) {
                this._inboundSignal.push(signal);
            }
        }

        // If we got some initial ops, then we know the gap and call above fetched ops to fill it.
        // Same is true for "write" mode even if we have no ops - we will get self "join" ops very very soon.
        // However if we are connecting as view-only, then there is no good signal to realize if client is behind.
        // Thus we have to hit storage to see if any ops are there.
        if (initialMessages.length === 0) {
            if (checkpointSequenceNumber !== undefined) {
                // We know how far we are behind (roughly). If it's non-zero gap, fetch ops right away.
                if (checkpointSequenceNumber > this.lastQueuedSequenceNumber) {
                    this.fetchMissingDeltas("AfterConnection", this.lastQueuedSequenceNumber);
                }
            // we do not know the gap, and we will not learn about it if socket is quite - have to ask.
            } else if (this.statefulDocumentDeltaConnection.mode !== "write") {
                this.fetchMissingDeltas("AfterConnection", this.lastQueuedSequenceNumber);
            }
        }

        this.connectFirstConnection = false;
    };

    private readonly disconnectedHandler = () => {
        // We cancel all ops on lost of connectivity, and rely on DDSes to resubmit them.
        // Semantics are not well defined for batches (and they are broken right now on disconnects anyway),
        // but it's safe to assume (until better design is put into place) that batches should not exist
        // across multiple connections. Right now we assume runtime will not submit any ops in disconnected
        // state. As requirements change, so should these checks.
        assert(this.messageBuffer.length === 0, 0x0ea /* "messageBuffer is not empty on disconnect" */);

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this._outbound.pause();
        this._outbound.clear();
        this.emit("disconnect");
    };

    // returns parts of message (in string format) that should never change for a given message.
    // Used for message comparison. It attempts to avoid comparing fields that potentially may differ.
    // for example, it's not clear if serverMetadata or timestamp property is a property of message or server state.
    // We only extract the most obvious fields that are sufficient (with high probability) to detect sequence number
    // reuse.
    // Also payload goes to telemetry, so no PII, including content!!
    // Note: It's possible for a duplicate op to be broadcasted and have everything the same except the timestamp.
    private comparableMessagePayload(m: ISequencedDocumentMessage) {
        return `${m.clientId}-${m.type}-${m.minimumSequenceNumber}-${m.referenceSequenceNumber}-${m.timestamp}`;
    }

    private enqueueMessages(
        messages: ISequencedDocumentMessage[],
        reason: string,
        allowGaps = false,
    ): void {
        if (this.handler === undefined) {
            // We did not setup handler yet.
            // This happens when we connect to web socket faster than we get attributes for container
            // and thus faster than attachOpHandler() is called
            // this.lastProcessedSequenceNumber is still zero, so we can't rely on this.fetchMissingDeltas()
            // to do the right thing.
            this.pending = this.pending.concat(messages);
            return;
        }

        // Pending ops should never just hang around for nothing.
        // This invariant will stay true through this function execution,
        // so there is no need to process pending ops here.
        // It's responsibility of
        // - attachOpHandler()
        // - fetchMissingDeltas() after it's done with querying storage
        assert(this.pending.length === 0 || this.fetchReason !== undefined, 0x1e9 /* "Pending ops" */);

        if (messages.length === 0) {
            return;
        }

        this.updateLatestKnownOpSeqNumber(messages[messages.length - 1].sequenceNumber);

        const n = this.previouslyProcessedMessage?.sequenceNumber;
        assert(n === undefined || n === this.lastQueuedSequenceNumber,
            0x0ec /* "Unexpected value for previously processed message's sequence number" */);

        for (const message of messages) {
            // Check that the messages are arriving in the expected order
            if (message.sequenceNumber <= this.lastQueuedSequenceNumber) {
                // Validate that we do not have data loss, i.e. sequencing is reset and started again
                // with numbers that this client already observed before.
                if (this.previouslyProcessedMessage?.sequenceNumber === message.sequenceNumber) {
                    const message1 = this.comparableMessagePayload(this.previouslyProcessedMessage);
                    const message2 = this.comparableMessagePayload(message);
                    if (message1 !== message2) {
                        const clientId = this.statefulDocumentDeltaConnection.connected
                            ? this.statefulDocumentDeltaConnection.clientId
                            : undefined;
                        const error = new NonRetryableError(
                            "Two messages with same seq# and different payload!",
                            DriverErrorType.fileOverwrittenInStorage,
                            {
                                clientId,
                                sequenceNumber: message.sequenceNumber,
                                message1,
                                message2,
                            },
                        );
                        this.close(error);
                    }
                }
            } else if (message.sequenceNumber !== this.lastQueuedSequenceNumber + 1) {
                this.pending.push(message);
                this.fetchMissingDeltas(reason, this.lastQueuedSequenceNumber, message.sequenceNumber);
            } else {
                this.lastQueuedSequenceNumber = message.sequenceNumber;
                this.previouslyProcessedMessage = message;
                this._inbound.push(message);
            }
        }
    }

    private processInboundMessage(message: ISequencedDocumentMessage): void {
        const startTime = Date.now();
        this.lastProcessedMessage = message;

        // All non-system messages are coming from some client, and should have clientId
        // System messages may have no clientId (but some do, like propose, noop, summarize)
        assert(
            message.clientId !== undefined
            || isSystemMessage(message),
            0x0ed /* "non-system message have to have clientId" */,
        );

        // if we have connection, and message is local, then we better treat is as local!
        assert(
            !this.statefulDocumentDeltaConnection.connected
            || this.statefulDocumentDeltaConnection.clientId !== message.clientId
            || this.lastSubmittedClientId === message.clientId,
            0x0ee /* "Not accounting local messages correctly" */,
        );

        if (this.lastSubmittedClientId !== undefined && this.lastSubmittedClientId === message.clientId) {
            const clientSequenceNumber = message.clientSequenceNumber;

            assert(this.clientSequenceNumberObserved < clientSequenceNumber, 0x0ef /* "client seq# not growing" */);
            assert(clientSequenceNumber <= this.clientSequenceNumber,
                0x0f0 /* "Incoming local client seq# > generated by this client" */);

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

        // Add final ack trace.
        if (message.traces !== undefined && message.traces.length > 0) {
            message.traces.push({
                action: "end",
                service: "client",
                timestamp: Date.now(),
            });
        }

        // Watch the minimum sequence number and be ready to update as needed
        if (this.minSequenceNumber > message.minimumSequenceNumber) {
            const clientId = this.statefulDocumentDeltaConnection.connected
                ? this.statefulDocumentDeltaConnection.clientId
                : undefined;
            throw new DataCorruptionError("msn moves backwards", {
                ...extractLogSafeMessageProperties(message),
                clientId,
            });
        }
        this.minSequenceNumber = message.minimumSequenceNumber;

        if (message.sequenceNumber !== this.lastProcessedSequenceNumber + 1) {
            const clientId = this.statefulDocumentDeltaConnection.connected
                ? this.statefulDocumentDeltaConnection.clientId
                : undefined;
            throw new DataCorruptionError("non-seq seq#", {
                ...extractLogSafeMessageProperties(message),
                clientId,
            });
        }
        this.lastProcessedSequenceNumber = message.sequenceNumber;

        // Back-compat for older server with no term
        if (message.term === undefined) {
            message.term = 1;
        }
        this.baseTerm = message.term;

        if (this.handler === undefined) {
            throw new Error("Attempted to process an inbound message without a handler attached");
        }
        this.handler.process(message);

        const endTime = Date.now();
        this.emit("op", message, endTime - startTime);
    }

    /**
     * Retrieves the missing deltas between the given sequence numbers
     */
     private fetchMissingDeltas(reasonArg: string, lastKnowOp: number, to?: number) {
         // eslint-disable-next-line @typescript-eslint/no-floating-promises
         this.fetchMissingDeltasCore(reasonArg, false /* cacheOnly */, lastKnowOp, to);
     }

     /**
     * Retrieves the missing deltas between the given sequence numbers
     */
    private async fetchMissingDeltasCore(
        reason: string,
        cacheOnly: boolean,
        lastKnowOp: number,
        to?: number)
    {
        // Exit out early if we're already fetching deltas
        if (this.fetchReason !== undefined) {
            return;
        }

        if (this.closed) {
            this.logger.sendTelemetryEvent({ eventName: "fetchMissingDeltasClosedConnection" });
            return;
        }

        try {
            assert(lastKnowOp === this.lastQueuedSequenceNumber, 0x0f1 /* "from arg" */);
            let from = lastKnowOp + 1;

            const n = this.previouslyProcessedMessage?.sequenceNumber;
            if (n !== undefined) {
                // If we already processed at least one op, then we have this.previouslyProcessedMessage populated
                // and can use it to validate that we are operating on same file, i.e. it was not overwritten.
                // Knowing about this mechanism, we could ask for op we already observed to increase validation.
                // This is especially useful when coming out of offline mode or loading from
                // very old cached (by client / driver) snapshot.
                assert(n === lastKnowOp, 0x0f2 /* "previouslyProcessedMessage" */);
                assert(from > 1, 0x0f3 /* "not positive" */);
                from--;
            }

            const fetchReason = `${reason}_fetch`;
            this.fetchReason = fetchReason;

            await this.getDeltas(
                from,
                to,
                (messages) => {
                    this.refreshDelayInfo(this.deltaStorageDelayId);
                    this.enqueueMessages(messages, fetchReason);
                },
                cacheOnly);
        } catch (error) {
            this.logger.sendErrorEvent({eventName: "GetDeltas_Exception"}, error);
            this.close(CreateContainerError(error));
        } finally {
            this.refreshDelayInfo(this.deltaStorageDelayId);
            this.fetchReason = undefined;
            this.processPendingOps(reason);
        }
    }

    /**
     * Sorts pending ops and attempts to apply them
     */
    private processPendingOps(reason?: string): void {
        if (this.handler !== undefined) {
            const pendingSorted = this.pending.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
            this.pending = [];
            // Given that we do not track where these ops came from any more, it's not very
            // actionably to report gaps in this range.
            this.enqueueMessages(pendingSorted, `${reason}_pending`, true /* allowGaps */);
        }
    }

    private updateLatestKnownOpSeqNumber(seq: number) {
        if (this.lastObservedSeqNumber < seq) {
            this.lastObservedSeqNumber = seq;
        }
    }
}

// TODO: move this elsewhere and use it more broadly for DataCorruptionError/DataProcessingError
function extractLogSafeMessageProperties(message: Partial<ISequencedDocumentMessage>) {
    const safeProps = {
        messageClientId: message.clientId,
        sequenceNumber: message.sequenceNumber,
        clientSequenceNumber: message.clientSequenceNumber,
        referenceSequenceNumber: message.referenceSequenceNumber,
        minimumSequenceNumber: message.minimumSequenceNumber,
        messageTimestamp: message.timestamp,
    };

    return safeProps;
}
