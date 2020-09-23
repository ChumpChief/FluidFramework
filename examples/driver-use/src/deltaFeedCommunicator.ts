/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IErrorEvent } from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IRuntime } from "@fluidframework/container-definitions";

import { IDeltaFeedFollower } from "./deltaFeedFollower";

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaFeedCommunicatorEvents extends IErrorEvent {
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaFeedCommunicator extends IEventProvider<IDeltaFeedCommunicatorEvents> {
}

export class DeltaFeedCommunicator
    extends TypedEventEmitter<IDeltaFeedCommunicatorEvents>
    implements IDeltaFeedCommunicator {
    private lastProcessedOpSequenceNumber: number;
    constructor(
        private readonly deltaFeedFollower: IDeltaFeedFollower,
        private readonly containerRuntime: IRuntime,
    ) {
        super();
        this.lastProcessedOpSequenceNumber = -1;
        this.deltaFeedFollower.on("sequentialOpsAvailable", this.handleSequentialOpsAvailable);
    }

    private readonly handleSequentialOpsAvailable = () => {
        while (this.lastProcessedOpSequenceNumber < this.deltaFeedFollower.sequentialOps.length) {
            const nextOp = this.deltaFeedFollower.sequentialOps[this.lastProcessedOpSequenceNumber + 1];
            this.containerRuntime.process(
                nextOp,
                true,
                undefined,
            );
            this.lastProcessedOpSequenceNumber++;
        }
    };
}
