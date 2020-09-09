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
    private disjointOps: ISequencedDocumentMessage[] = [];
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
        deltaFeed.on("op", (documentId, ops) => { this.processOps(ops); });
    }

    // Currently this is expecting to be called either in response to the op event, after retrieving missing ops from
    // storage, or when reattempting the disjoint ops after processing those missing ops
    private processOps(ops: ISequencedDocumentMessage[]) {
        for (const op of ops) {
            assert.strict(
                op.sequenceNumber > this.latestProcessedOpSequenceNumber,
                "Incoming op sequence numbers should always increase",
            );
            if (op.sequenceNumber === this.latestProcessedOpSequenceNumber + 1) {
                this.sequentialOps.push(op);
                this.latestProcessedOpSequenceNumber = op.sequenceNumber;
            } else if (op.sequenceNumber >= this.latestProcessedOpSequenceNumber + 1) {
                // this is wrong
                this.disjointOps.push(op);
                // go fetch the missing ops
                this.fetchMissingOps(op.sequenceNumber);
                // maybe proactively push the remaining ops into disjoint since they're all presumably later?
            }
        }
    }

    // If we see an op come in that is in the "future", we will try to get the ops we "missed" from storage.
    // After getting them, we will process those ops first, and then the "future ops" (which at that point will
    // hopefully be "present ops").
    private async fetchMissingOps(to: number) {
        const missingOps = await this.deltaStorage.get(this.latestProcessedOpSequenceNumber, to);
        this.processOps(missingOps);
        this.processDisjointOps();
    }

    // Empty the disjoint op buffer and run them through processing again.  If there is more disjointedness we might
    // have to go through again.
    private processDisjointOps() {
        const disjointOps = this.disjointOps;
        this.disjointOps = [];
        this.processOps(disjointOps);
    }
}
