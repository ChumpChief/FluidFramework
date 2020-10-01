/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IErrorEvent } from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentMessage, MessageType } from "@fluidframework/protocol-definitions";

import { IDeltaStream } from "./socketIoDeltaStream";

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaStreamWriterEvents extends IErrorEvent {
}

export interface IDeltaStreamWriter extends IEventProvider<IDeltaStreamWriterEvents> {
    submit(type: MessageType, contents: any, referenceSequenceNumber: number): number;
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
export class DeltaStreamWriter
    extends TypedEventEmitter<IDeltaStreamWriterEvents>
    implements IDeltaStreamWriter {
    private clientSequenceNumber: number = 0;
    constructor(
        private readonly deltaStream: IDeltaStream,
    ) {
        super();
        // TODO does nack handling belong here?
    }

    // Thinking something like this, promise resolves after real submit to network
    // const submissionP = writer.submit(...);
    // submissionP.then((submissionDetails) => { waitingForAckQueue.push({ submissionDetails, metadata }); });
    // TODO contents should be Jsonable, not any
    public submit(type: MessageType, contents: any, referenceSequenceNumber: number) {
        // TODO maybe include clientId in here or something?  Or have it returned from the deltaStream.submit()?
        const message: IDocumentMessage = {
            clientSequenceNumber: ++this.clientSequenceNumber,
            contents: JSON.stringify(contents),
            referenceSequenceNumber,
            type,
        };

        // await this.deltaStream.canSubmit() or something here maybe
        // maybe do a similar promise chain to keep the order correct?

        this.deltaStream.submit(message);
        // If async, this will also include the clientId it was submitted under
        return this.clientSequenceNumber;
    }
}
