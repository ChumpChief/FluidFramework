/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDeliState } from "../../server-services-core";
import { ICheckpointParams, IDeliCheckpointManager } from "./checkpointManager";

export class CheckpointContext {
    private pendingUpdateP: Promise<void> | undefined;
    private pendingCheckpoint: ICheckpointParams | undefined;
    private closed = false;
    private lastKafkaCheckpointOffset: number | undefined;

    constructor(private readonly checkpointManager: IDeliCheckpointManager) { }

    public checkpoint(checkpoint: ICheckpointParams) {
        // Exit early if already closed
        if (this.closed) {
            return;
        }

        // Check if a checkpoint is in progress - if so store the pending checkpoint
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        if (this.pendingUpdateP) {
            this.pendingCheckpoint = checkpoint;
            return;
        }

        // Write the checkpoint data to MongoDB
        this.pendingUpdateP = this.checkpointCore(checkpoint);
        this.pendingUpdateP?.then(
            () => {
                // kafka checkpoint
                // depending on the sequence of events, it might try to checkpoint the same offset a second time
                // detect and prevent that case here
                const kafkaCheckpointMessage = checkpoint.kafkaCheckpointMessage;
                if (kafkaCheckpointMessage &&
                    (this.lastKafkaCheckpointOffset === undefined ||
                        kafkaCheckpointMessage.offset > this.lastKafkaCheckpointOffset)) {
                    this.lastKafkaCheckpointOffset = kafkaCheckpointMessage.offset;
                }

                this.pendingUpdateP = undefined;

                // Trigger another round if there is a pending update
                if (this.pendingCheckpoint) {
                    const pendingCheckpoint = this.pendingCheckpoint;
                    this.pendingCheckpoint = undefined;
                    this.checkpoint(pendingCheckpoint);
                }
            }).catch(() => { });
    }

    public close() {
        this.closed = true;
    }

    private checkpointCore(checkpoint: ICheckpointParams) {
        // Exit early if already closed
        if (this.closed) {
            return;
        }

        let updateP: Promise<void>;

        if (checkpoint.clear) {
            updateP = this.checkpointManager.deleteCheckpoint(checkpoint);
        } else {
            // clone the checkpoint
            const deliCheckpoint: IDeliState = { ...checkpoint.deliState };

            updateP = this.checkpointManager.writeCheckpoint(deliCheckpoint);
        }

        // Retry the checkpoint on error
        return updateP.catch((error) => {
            return new Promise<void>((resolve, reject) => {
                resolve(this.checkpointCore(checkpoint));
            });
        });
    }
}
