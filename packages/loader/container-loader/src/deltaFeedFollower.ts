/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { IDeltaFeedFollower, IDeltaFeedFollowerEvents } from "@fluidframework/container-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDeltaFeed, IDocumentDeltaStorageService } from "@fluidframework/driver-definitions";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";

export class DeltaFeedFollower extends TypedEventEmitter<IDeltaFeedFollowerEvents> implements IDeltaFeedFollower {
    // The op buffer that can be read from as desired.
    private readonly sequentialOps: ISequencedDocumentMessage[] = [];
    // Ops that we've received from the future (ahead of the expected sequence number)
    // The feed follower should go find out what the missing ops are so we can complete the sequence.
    private readonly disjointOps: ISequencedDocumentMessage[] = [];
    // To determine whether the next op we see is sequential or disjoint, we'll see if it's one more than
    // the latestProcessedOpSequenceNumber.
    private latestProcessedOpSequenceNumber: number = 0;

    constructor(
        private readonly deltaFeed: IDeltaFeed,
        private readonly deltaStorage: IDocumentDeltaStorageService,
    ) {
        super();
        console.log(this.deltaFeed, this.deltaStorage, this.sequentialOps, this.disjointOps);
        // Consider pushing this down - can we start ignoring the documentId arg at the feed level?
        // And unpacking the array
        deltaFeed.on("op", (documentId, ops) => { this.processIncomingOps(ops); });
    }

    private processIncomingOps(ops: ISequencedDocumentMessage[]) {
        for (const op of ops) {
            assert.strict(
                op.sequenceNumber > this.latestProcessedOpSequenceNumber,
                "Incoming op sequence numbers should always increase",
            );
            if (op.sequenceNumber === this.latestProcessedOpSequenceNumber + 1) {
                this.sequentialOps.push(op);
                this.latestProcessedOpSequenceNumber = op.sequenceNumber;
            } else if (op.sequenceNumber >= this.latestProcessedOpSequenceNumber + 1) {
                this.disjointOps.push(op);
                // go fetch the missing ops
                // maybe proactively push the remaining ops into disjoint since they're all presumably later?
            }
        }
    }

    private fetchMissingOps(to: number) {
        
    }
}
