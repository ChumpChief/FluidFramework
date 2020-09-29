/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IErrorEvent } from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentDeltaStorageService } from "@fluidframework/driver-definitions";
import { ISequencedDocumentMessage, MessageType } from "@fluidframework/protocol-definitions";
import { DeltaStreamFollower, IDeltaStreamFollower } from "./deltaStreamFollower";
import { DeltaStreamWriter, IDeltaStreamWriter } from "./deltaStreamWriter";

import { IDeltaStream } from "./socketIoDeltaStream";

export interface IDeltaStreamManagerEvents extends IErrorEvent {
    (event: "opsAvailable", listener: () => void);
}

export interface IDeltaStreamManager extends IEventProvider<IDeltaStreamManagerEvents> {
    hasAvailableOps(): boolean;
    pullOp(): IAvailableOp;
    submit(type: MessageType, contents: any);
}

interface IAvailableOp {
    local: boolean;
    op: ISequencedDocumentMessage;
}

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
export class DeltaStreamManager extends TypedEventEmitter<IDeltaStreamManagerEvents> implements IDeltaStreamManager {
    private readonly deltaStreamFollower: IDeltaStreamFollower;
    private readonly deltaStreamWriter: IDeltaStreamWriter;
    private lastProcessedOpSequenceNumber = 0;
    private readonly availableOps: IAvailableOp[] = [];

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
        return this.deltaStreamWriter.submit(type, contents, this.lastProcessedOpSequenceNumber);
    }

    public hasAvailableOps(): boolean {
        return this.availableOps.length > 0;
    }

    public pullOp(): IAvailableOp {
        const nextOp = this.availableOps.shift();
        if (nextOp === undefined) {
            throw new Error("Attempted to pullOp with no available ops");
        }
        this.lastProcessedOpSequenceNumber = nextOp.op.sequenceNumber;
        return nextOp;
    }

    private readonly processOps = () => {
        const isOpLocal = (op: ISequencedDocumentMessage) => {
            if (this.deltaStream.connectionInfo === undefined) {
                throw new Error("Cannot compute local ops when disconnected");
            }
            // TODO this needs something more sophisticated - client ID doesn't persist across reconnect
            return op.clientId === this.deltaStream.connectionInfo.clientId;
        };

        // Note: op sequence numbers are 1-indexed, is why this works
        while (this.lastProcessedOpSequenceNumber < this.deltaStreamFollower.sequentialOps.length) {
            const nextOp = { ...this.deltaStreamFollower.sequentialOps[this.lastProcessedOpSequenceNumber] };

            // Need to convert from string to object
            nextOp.contents = JSON.parse(nextOp.contents);

            this.availableOps.push({
                local: isOpLocal(nextOp),
                op: nextOp,
            });
            this.emit("opsAvailable");
        }
    };
}
