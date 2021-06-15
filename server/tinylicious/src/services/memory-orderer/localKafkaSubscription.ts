/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import * as Deque from "double-ended-queue";
import { IQueuedMessage } from "../../server-services-core";
import { IKafkaSubscriber } from "./interfaces";

/**
 * A subscription for a single lambda
 *  todo: use context checkpoints
 */
export class LocalKafkaSubscription extends EventEmitter {
    public queueOffset: number = 0;

    private closed = false;
    private processing = false;
    private retryTimer: NodeJS.Timeout | undefined;

    constructor(private readonly subscriber: IKafkaSubscriber, private readonly queue: Deque<IQueuedMessage>) {
        super();
    }

    public close() {
        this.closed = true;

        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }

        this.removeAllListeners();
    }

    public async process() {
        if (this.queue.length <= this.queueOffset || this.processing || this.retryTimer !== undefined || this.closed) {
            return;
        }

        const message = this.queue.get(this.queueOffset);

        try {
            this.processing = true;

            const optionalPromise = this.subscriber.process(message);
            if (optionalPromise !== undefined) {
                await optionalPromise;
            }

            this.queueOffset++;

            this.emit("processed", this.queueOffset);
        } catch (ex) {
            this.retryTimer = setTimeout(() => {
                this.retryTimer = undefined;
                void this.process();
            }, 500);

            return;
        } finally {
            this.processing = false;
        }

        // Process the next one
        void this.process();
    }
}
