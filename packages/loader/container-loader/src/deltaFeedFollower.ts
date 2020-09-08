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
    // The message buffer that can be read from as desired.
    private readonly sequentialMessages: ISequencedDocumentMessage[] = [];
    // Messages that we've received from the future (ahead of the expected sequence number)
    // The feed follower should go find out what the missing messages are so we can complete the sequence.
    private readonly disjointMessages: ISequencedDocumentMessage[] = [];
    // To determine whether the next message we see is sequential or disjoint, we'll see if it's one more than
    // the latestProcessedMessageSequenceNumber.
    private latestProcessedMessageSequenceNumber: number = 0;

    constructor(
        private readonly deltaFeed: IDeltaFeed,
        private readonly deltaStorage: IDocumentDeltaStorageService,
    ) {
        super();
        console.log(this.deltaFeed, this.deltaStorage, this.sequentialMessages, this.disjointMessages);
        // Consider pushing this down - can we start ignoring the documentId arg at the feed level?
        deltaFeed.on("op", (documentId, messages) => { this.processIncomingOps(messages); });
    }

    private processIncomingOps(messages: ISequencedDocumentMessage[]) {
        for (const message of messages) {
            assert.strict(
                message.sequenceNumber > this.latestProcessedMessageSequenceNumber,
                "Incoming op sequence numbers should always increase",
            );
            if (message.sequenceNumber === this.latestProcessedMessageSequenceNumber + 1) {
                this.sequentialMessages.push(message);
                this.latestProcessedMessageSequenceNumber = message.sequenceNumber;
            } else if (message.sequenceNumber >= this.latestProcessedMessageSequenceNumber + 1) {
                this.disjointMessages.push(message);
                // go fetch the missing messages
                // maybe proactively push the remaining messages into disjoint since they're all presumably later?
            }
        }
    }
}
