/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IErrorEvent } from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentMessage, MessageType } from "@fluidframework/protocol-definitions";
// import { IRuntime } from "@fluidframework/container-definitions";

import { IDeltaFeedFollower } from "./deltaFeedFollower";
import { IDeltaFeed } from "./socketIoDeltaFeed";

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaFeedCommunicatorEvents extends IErrorEvent {
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaFeedCommunicator extends IEventProvider<IDeltaFeedCommunicatorEvents> {
}

export class DeltaFeedCommunicator
    extends TypedEventEmitter<IDeltaFeedCommunicatorEvents>
    implements IDeltaFeedCommunicator {
    private clientSequenceNumber: number = 0;
    private lastProcessedOpSequenceNumber: number;
    constructor(
        private readonly deltaFeed: IDeltaFeed,
        private readonly deltaFeedFollower: IDeltaFeedFollower,
        // private readonly containerRuntime: IRuntime,
    ) {
        super();
        this.lastProcessedOpSequenceNumber = -1;
        this.deltaFeedFollower.on("sequentialOpsAvailable", this.handleSequentialOpsAvailable);
    }

    private readonly handleSequentialOpsAvailable = () => {
        // TODO maybe off by one, unclear if this should be 1-indexed
        while (this.lastProcessedOpSequenceNumber < this.deltaFeedFollower.sequentialOps.length - 1) {
            const nextOp = this.deltaFeedFollower.sequentialOps[this.lastProcessedOpSequenceNumber + 1];
            // TODO should local computation be pushed down into the IDeltaFeed?
            const nextOpLocal = nextOp.clientId === this.deltaFeed.connectionInfo.clientId;
            // this.containerRuntime.process(
            //     nextOp,
            //     true,
            // );
            console.log(nextOp, nextOpLocal);
            this.lastProcessedOpSequenceNumber++;
        }
    };

    // TODO contents should be Jsonable, not any
    public submit(type: MessageType, contents: any) {
        const message: IDocumentMessage = {
            clientSequenceNumber: ++this.clientSequenceNumber,
            contents: JSON.stringify(contents),
            referenceSequenceNumber: this.lastProcessedOpSequenceNumber,
            type,
        };
        this.deltaFeed.submit(message);
        return this.clientSequenceNumber;
    }
}
