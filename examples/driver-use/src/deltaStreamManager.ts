/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { IEventProvider, IErrorEvent } from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentDeltaStorageService } from "@fluidframework/driver-definitions";
import { ISequencedDocumentMessage, MessageType } from "@fluidframework/protocol-definitions";
import { v4 as uuid } from "uuid";

import { DeltaStreamFollower, IDeltaStreamFollower } from "./deltaStreamFollower";
import { DeltaStreamWriter, IDeltaStreamWriter } from "./deltaStreamWriter";

import { IDeltaStream } from "./socketIoDeltaStream";

export interface IDeltaStreamManagerEvents extends IErrorEvent {
    (event: "opPrepared" | "upToDate", listener: () => void);
}

export interface IDeltaStreamManager extends IEventProvider<IDeltaStreamManagerEvents> {
    hasAvailableOps(): boolean;
    pullOp(): IAvailableOp;
    submit(type: MessageType, contents: any);
}

interface IAvailableOp {
    local: boolean;
    op: ISequencedDocumentMessage;
    localMessageId: string | undefined;
    metadata: any | undefined;
}

// TODO if instead we want the metadata to be handled externally, we need to provide back a unique identifier that
// can be used to match an incoming op.  Today, this is a clientId + clientSequenceNumber combo, but we won't have
// that available at the time the op is submitted (the clientId might change if the connection drops).  So we'll
// instead need to provide back a guid or something that we'll match internally.  This might be nice anyway to help
// hide the clientId.
interface IPendingSendOp {
    type: MessageType;
    contents: any;
    localMessageId: string;
    referenceSequenceNumber: number;
}

// TODO Do I need to retain the type/contents/ref here in case of resubmit case?  Like if I get NACK'd?
interface IPendingAckOp {
    clientId: string;
    clientSequenceNumber: number;
    localMessageId: string;
}

const localMessageIdMapKey = (clientId: string, clientSequenceNumber: number) => `${clientId}#${clientSequenceNumber}`;

// This is now protocol layer?  Does this really need to exist as a separate object?
// Should probably hold a queue of outbound rather than direct-submitting
// Probably sends without caring about acks -- let the layer above care about acks?
// Maybe needs to confirm to the layer above when the message actually gets sent (e.g. if in offline
// mode then maybe it just sits in a queue for a while)?

// Runtime tells the manager "here is content and metadata for the op I want to submit"
// Manager pushes the content into the writer, where it sits in a queue for submission
// -- if in offline state it will just sit there
// -- if in online state it will go ahead and get submitted for real
// After real submission, the op moves from the submission queue to the waiting for ack queue along with metadata
// (this waiting for ack queue prob lives in the manager instead - writer emits event to let it know)
// (Maybe it actually moves there immediately but with a flag to indicate whether it's really submitted?)
// -- These "real submissions" also offer up the clientId that the op was submitted under to help compute local later?
// When ops come in to the follower, the manager prepares them for processing, puts them in a ready-for-process queue.
// -- First it uses the waiting for ack queue to compute local, and retrieve the relevant metadata
// Then runtime does something like ContainerRuntime.process to actually do anything with the message.

// I just want to sync write type/content/metadata, not think about connected.
// I want to sync read op content plus get out the metadata and know local
export class DeltaStreamManager extends TypedEventEmitter<IDeltaStreamManagerEvents> implements IDeltaStreamManager {
    private readonly deltaStreamFollower: IDeltaStreamFollower;
    private readonly deltaStreamWriter: IDeltaStreamWriter;
    private lastPreparedOpSequenceNumber = 0;
    private lastPulledOpSequenceNumber = 0;
    private readonly availableOps: IAvailableOp[] = [];
    private readonly pendingSend: IPendingSendOp[] = [];
    private readonly pendingAck: IPendingAckOp[] = [];
    private readonly metadataStash: Map<string, unknown> = new Map<string, unknown>();
    private readonly localMessageIdMap: Map<string, string> = new Map<string, string>();
    private sendingP: Promise<void> | undefined;

    constructor(
        private readonly deltaStream: IDeltaStream,
        private readonly deltaStorage: IDocumentDeltaStorageService,
    ) {
        super();

        this.deltaStreamFollower = new DeltaStreamFollower(this.deltaStream, this.deltaStorage, 0);
        this.deltaStreamWriter = new DeltaStreamWriter(this.deltaStream);

        this.deltaStreamFollower.on("upToDate", this.processOps);
    }

    // Thinking something like this, promise resolves after real submit to network
    // const submissionP = writer.submit(...);
    // submissionP.then((submissionDetails) => { waitingForAckQueue.push({ submissionDetails, metadata }); });
    // TODO contents should be Jsonable, not any
    public submit(type: MessageType, contents: any) {
        const localMessageId = uuid();
        // TODO Need to either take in the metadata or return the localMessageId for the caller to use
        this.metadataStash.set(localMessageId, undefined);

        this.pendingSend.push({
            type,
            contents,
            localMessageId,
            referenceSequenceNumber: this.lastPulledOpSequenceNumber,
        });

        // this part should be in a separate method
        const clientSequenceNumber = this.deltaStreamWriter.submit(type, contents, this.lastPulledOpSequenceNumber);
        const clientId = this.deltaStream.connectionInfo?.clientId;
        // This should actually be guaranteed already if we're deciding to real-send
        if (clientId !== undefined) {
            this.localMessageIdMap.set(localMessageIdMapKey(clientId, clientSequenceNumber), localMessageId);
            this.pendingAck.push({
                clientId,
                clientSequenceNumber,
                localMessageId,
            });
        }
        return clientSequenceNumber;
    }

    public submitNew(type: MessageType, contents: any, metadata: unknown) {
        const localMessageId = uuid();
        // TODO Need to either take in the metadata or the caller needs to use the returned localMessageId
        // to do its own stashing
        this.metadataStash.set(localMessageId, metadata);

        this.pendingSend.push({
            type,
            contents,
            localMessageId,
            referenceSequenceNumber: this.lastPulledOpSequenceNumber,
        });

        if (this.sendingP === undefined) {
            this.sendingP = this.ensureSending()
                .finally(() => { this.sendingP = undefined; });
        }

        return localMessageId;
    }

    private async ensureSending() {
        while (this.pendingSend.length > 0) {
            // await can send
            const nextOp = this.pendingSend.shift();
            if (nextOp === undefined) {
                throw new Error("The op we expected to send vanished before we could send it");
            }
            const clientSequenceNumber = this.deltaStreamWriter.submit(
                nextOp.type,
                nextOp.contents,
                nextOp.referenceSequenceNumber,
            );

            const clientId = this.deltaStream.connectionInfo?.clientId;
            if (clientId === undefined) {
                throw new Error("Mistakenly thought we were connected and tried to send");
            }

            this.localMessageIdMap.set(
                localMessageIdMapKey(clientId, clientSequenceNumber),
                nextOp.localMessageId,
            );
            this.pendingAck.push({
                clientId,
                clientSequenceNumber,
                localMessageId: nextOp.localMessageId,
            });
        }
    }

    public hasAvailableOps(): boolean {
        return this.availableOps.length > 0;
    }

    public pullOp(): IAvailableOp {
        const nextOp = this.availableOps.shift();
        if (nextOp === undefined) {
            throw new Error("Attempted to pullOp with no available ops");
        }
        this.lastPulledOpSequenceNumber = nextOp.op.sequenceNumber;
        return nextOp;
    }

    /**
     * processOps will run when the DeltaStreamFollower has finished sequencing a set of ops.  Its job is to
     * take those ops, groom them with information like local, metadata, parse the JSON, etc. and make them
     * available to the upper layers (with an event to let them know they are available).
     *
     * TODO needs to weed out system messages.
     */
    private readonly processOps = () => {
        const isOpLocal = (op: ISequencedDocumentMessage) => {
            if (this.deltaStream.connectionInfo === undefined) {
                throw new Error("Cannot compute local ops when disconnected");
            }
            // TODO this needs something more sophisticated - client ID doesn't persist across reconnect
            // Maybe search our pendingAck collection to see if we get a match
            return op.clientId === this.deltaStream.connectionInfo.clientId;
        };

        // Note: op sequence numbers are 1-indexed, is why this works
        while (this.lastPreparedOpSequenceNumber < this.deltaStreamFollower.sequentialOps.length) {
            const nextOp = { ...this.deltaStreamFollower.sequentialOps[this.lastPreparedOpSequenceNumber] };

            // Need to convert from string to object
            nextOp.contents = JSON.parse(nextOp.contents);

            const local = isOpLocal(nextOp);

            // We'll get the message id off the map based on the clientId and clientSequenceNumber
            let localMessageId: string | undefined;
            if (local) {
                localMessageId = this.localMessageIdMap.get(
                    localMessageIdMapKey(nextOp.clientId, nextOp.clientSequenceNumber),
                );
                if (localMessageId === undefined) {
                    throw new Error("Couldn't find the localMessageId");
                }
                // TODO Should I be doing more validation here?  Using the stashed info?  Or is that really only
                // needed for resubmit
                assert(this.pendingAck[0] !== undefined, "Wasn't expecting an ack");
                assert(localMessageId === this.pendingAck[0].localMessageId, "Ack different from expected");
                this.pendingAck.shift();
            }

            const metadata = localMessageId !== undefined
                ? this.metadataStash.get(localMessageId)
                : undefined;

            this.availableOps.push({
                local,
                op: nextOp,
                localMessageId,
                metadata,
            });
            this.lastPreparedOpSequenceNumber++;
            this.emit("opPrepared");
        }
        this.emit("upToDate");
    };
}
