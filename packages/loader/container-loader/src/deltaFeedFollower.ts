/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDeltaFeedFollower, IDeltaFeedFollowerEvents } from "@fluidframework/container-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDeltaFeed, IDocumentDeltaStorageService } from "@fluidframework/driver-definitions";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";

// eslint-disable-next-line max-len
export class DeltaFeedFollower extends TypedEventEmitter<IDeltaFeedFollowerEvents> implements IDeltaFeedFollower {
    // The message buffer that can be read from as desired.
    private readonly sequentialMessages: ISequencedDocumentMessage[] = [];
    // Messages that we've received from the future (ahead of the expected sequence number)
    // The feed follower should go find out what the missing messages are so we can complete the sequence.
    private readonly disjointMessages: ISequencedDocumentMessage[] = [];

    constructor(
        private readonly deltaFeed: IDeltaFeed,
        private readonly deltaStorage: IDocumentDeltaStorageService,
    ) {
        super();
        console.log(this.deltaFeed, this.deltaStorage, this.sequentialMessages, this.disjointMessages);
    }
}
