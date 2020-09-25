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
    (event: "sequentialOpsAvailable", listener: () => void);
}

export interface IDeltaStreamFollower extends IEventProvider<IDeltaStreamFollowerEvents> {
    // TODO Don't really want this to be directly public but rather with some controlled access (maybe via seq #?)
    readonly sequentialOps: ISequencedDocumentMessage[];
}

export class DeltaStreamFollower extends TypedEventEmitter<IDeltaStreamFollowerEvents> implements IDeltaStreamFollower {
    // The op buffer that can be read from as desired.  Guaranteed to not include disjoint spans.
    // TODO Don't really want this to be directly public but rather with some controlled access (maybe via seq #?)
    public readonly sequentialOps: ISequencedDocumentMessage[] = [];
    // The list of ops received via "op" events that have not yet been sequenced.  May include disjoint spans.
    private incomingOps: ISequencedDocumentMessage[] = [];
    // To determine whether the next op we see is sequential or disjoint, we'll see if it's one more than
    // the latestProcessedOpSequenceNumber.
    private latestSequentialOpSequenceNumber: number;
    private sequencingPromise: Promise<void> | undefined;

    constructor(
        private readonly deltaStream: IDeltaStream,
        private readonly deltaStorage: IDocumentDeltaStorageService,
        startAfterSequenceNumber: number,
    ) {
        super();
        this.latestSequentialOpSequenceNumber = startAfterSequenceNumber;
        this.deltaStream.on("op", this.handleIncomingOp);
    }

    // This will just append the incoming ops to the incoming op queue and ensure we're sequencing.
    private readonly handleIncomingOp = (op: ISequencedDocumentMessage) => {
        this.incomingOps.push(op);
        if (this.sequencingPromise === undefined) {
            this.sequencingPromise = this.sequenceOps()
                .then(() => { this.sequencingPromise = undefined; })
                .catch((err) => { console.error(err); });
        }
    };

    /**
     * sequenceOps's job is to take the incoming ops from the stream, validate they are sequential, and push them to
     * the list of sequentialOps.  If they are not sequential, it should attempt to correct (e.g. fetch missing ops
     * from deltaStorage) or error out.
     *
     * It will run async until the incoming op queue is empty, which allows it to use async approaches to the fixup
     * (like fetching ops).  Accordingly, we must hold its promise until the incoming op queue is empty to avoid
     * kicking off a duplicative async sequencing task.
     *
     * "Until it is empty" makes it easy to restrict this to only be called from the "op" event alone, without
     * recursion.  This makes it a bit easier to follow than the recursive approach used by DeltaManager currently
     * (enqueueMessages -> fetchMissingDeltas -> getDeltas -> catchUpCore -> enqueueMessages)
     */
    private async sequenceOps() {
        // Even if more ops come in while we are processing (i.e. while we are awaiting storage) the loop will still
        // iterate over those newly added ops.
        for (const incomingOp of this.incomingOps) {
            if (incomingOp.sequenceNumber > this.latestSequentialOpSequenceNumber + 1) {
                // We are missing some ops between the last one we saw and the one we just got, so we need to
                // fetch them.
                // TODO: Is there risk this will fail or only get some of the ops?  Maybe that should be handled in
                // the DeltaStorage driver though.
                const missingOps = await this.deltaStorage.get(
                    this.latestSequentialOpSequenceNumber,
                    incomingOp.sequenceNumber,
                );
                this.sequentialOps.push(...missingOps);
            }

            // Should handle if the incoming op is non-increasing (throw)?
            this.sequentialOps.push(incomingOp);
            this.latestSequentialOpSequenceNumber = incomingOp.sequenceNumber;
            // TODO: This approach fires a single time for a larger batch of ops, which probably offer performance
            // optimization opportunities?.  Consider exposing a per-op event though which would be easier to use.
            this.emit("sequentialOpsAvailable");
        }

        // Clear the ops we processed
        this.incomingOps = [];
    }
}
