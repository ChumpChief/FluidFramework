/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IErrorEvent } from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentDeltaStorageService } from "@fluidframework/driver-definitions";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";

import { IDeltaStream } from "./socketIoDeltaStream";

export interface IDeltaStreamFollowerEvents extends IErrorEvent {
    (event: "opSequenced" | "upToDate", listener: () => void);
}

export interface IDeltaStreamFollower extends IEventProvider<IDeltaStreamFollowerEvents> {
    // TODO Don't really want this to be directly public but rather with some controlled access (maybe via seq #?)
    readonly sequentialOps: ISequencedDocumentMessage[];
}

export class DeltaStreamFollower extends TypedEventEmitter<IDeltaStreamFollowerEvents> implements IDeltaStreamFollower {
    // The op buffer that can be read from as desired.  Guaranteed to not include disjoint spans (gaps).
    // TODO Don't really want this to be directly public but rather with some controlled access (maybe via seq #?)
    public readonly sequentialOps: ISequencedDocumentMessage[] = [];
    // To determine whether the next op we see is sequential or disjoint (a gap), we'll see if it's one more than
    // the latestOpSequenceNumber.
    private latestOpSequenceNumber: number;
    // sequenceP is a promise chain which will resolve when all ops received so far up to the current
    // latestOpSequenceNumber have been sequenced.  As new ops come in, we link new promises to the end of it.
    private sequenceP: Promise<void> = Promise.resolve();

    constructor(
        private readonly deltaStream: IDeltaStream,
        private readonly deltaStorage: IDocumentDeltaStorageService,
        startAfterSequenceNumber: number,
    ) {
        super();
        this.latestOpSequenceNumber = startAfterSequenceNumber;
        this.deltaStream.on("op", this.handleOpMessage);
    }

    private readonly sequenceOp = (op: ISequencedDocumentMessage) => {
        this.sequentialOps.push(op);
        this.emit("opSequenced");
        if (this.latestOpSequenceNumber === op.sequenceNumber) {
            this.emit("upToDate");
        }
    };

    /**
     * As ops come in, handleOpMessage will synchronously kick off the async steps to get them sequenced.  As it does,
     * it also updates the promise chain we use to track the completion of those async steps plus sequencing.
     * @param op - The newly received message
     */
    private readonly handleOpMessage = (op: ISequencedDocumentMessage) => {
        if (op.sequenceNumber > this.latestOpSequenceNumber + 1) {
            // We have a gap, kick off fetching the gap ops from deltaStorage
            const gapFetchP = this.deltaStorage.get(
                this.latestOpSequenceNumber,
                op.sequenceNumber,
            );
            // Once we've fetched the gap and sequenced all previous ops, sequence the gap
            this.sequenceP = Promise.all([gapFetchP, this.sequenceP])
                .then(([gapOps]) => { gapOps.forEach(this.sequenceOp); });
        }

        // Now we know there's no gap, so sequence the newly received op
        this.sequenceP = this.sequenceP
            .then(() => { this.sequenceOp(op); });

        // Update the latest op sequence number so we know which sequence number to expect next
        this.latestOpSequenceNumber = op.sequenceNumber;
    };
}
