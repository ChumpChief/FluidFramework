/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IErrorEvent } from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentDeltaStorageService } from "@fluidframework/driver-definitions";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";
import { IDeltaFeed } from "./socketIoDeltaFeed";

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaFeedFollowerEvents extends IErrorEvent {
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaFeedFollower extends IEventProvider<IDeltaFeedFollowerEvents> {
}

export class DeltaFeedFollower extends TypedEventEmitter<IDeltaFeedFollowerEvents> implements IDeltaFeedFollower {
    // The op buffer that can be read from as desired.  Guaranteed to not include disjoint spans.
    private readonly sequentialOps: ISequencedDocumentMessage[] = [];
    // The list of ops received via "op" events that have not yet been sequenced.  May include disjoint spans.
    private incomingOps: ISequencedDocumentMessage[] = [];
    // To determine whether the next op we see is sequential or disjoint, we'll see if it's one more than
    // the latestProcessedOpSequenceNumber.
    private latestSequentialOpSequenceNumber: number;
    private sequencingPromise: Promise<void> | undefined;

    constructor(
        deltaFeed: IDeltaFeed,
        private readonly deltaStorage: IDocumentDeltaStorageService,
        startAfterSequenceNumber: number,
    ) {
        super();
        this.latestSequentialOpSequenceNumber = startAfterSequenceNumber;
        deltaFeed.on("op", (op: ISequencedDocumentMessage) => { this.handleIncomingOp(op); });
    }

    // This will just append the incoming ops to the incoming op queue and ensure we're sequencing.
    private handleIncomingOp(op: ISequencedDocumentMessage) {
        this.incomingOps.push(op);
        if (this.sequencingPromise === undefined) {
            this.sequencingPromise = this.sequenceOps()
                .then(() => { this.sequencingPromise = undefined; })
                .catch((err) => { console.error(err); });
        }
    }

    // sequenceOps will run async until the incoming op queue is empty.  We'll hold the promise until it is done to
    // avoid reentrancy.
    private async sequenceOps() {
        // Even if more ops come in while we are processing (i.e. while we are awaiting storage) the loop will still
        // iterate over those newly added ops.
        for (const incomingOp of this.incomingOps) {
            if (incomingOp.sequenceNumber > this.latestSequentialOpSequenceNumber + 1) {
                // Should handle if this fails or only gets some of the ops?
                const missingOps = await this.deltaStorage.get(
                    this.latestSequentialOpSequenceNumber,
                    incomingOp.sequenceNumber,
                );
                this.sequentialOps.push(...missingOps);
            }

            // Should handle if the incoming op is non-increasing (throw)?
            this.sequentialOps.push(incomingOp);
            this.latestSequentialOpSequenceNumber = incomingOp.sequenceNumber;
        }

        // Clear the ops we processed
        this.incomingOps = [];
    }
}
