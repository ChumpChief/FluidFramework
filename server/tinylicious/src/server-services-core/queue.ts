/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { Deferred } from "../common-utils";

export interface IQueuedMessage {
    topic: string;
    partition: number;
    offset: number;
    value: string | any;
}

export interface IPartition {
    topic: string;
    partition: number;
    offset: number;
}

/**
 * A pending message the producer is holding on to
 */
export interface IPendingMessage {
    // The deferred is used to resolve a promise once the message is sent
    deferred: Deferred<any>;

    // The message to send
    message: string;
}

export interface IProducer {
    /**
     * Returns true if the producer is connected
     */
    isConnected(): boolean;

    /**
     * Sends the message to a queue
     */
    // eslint-disable-next-line @typescript-eslint/ban-types
    send(messages: object[], tenantId: string, documentId: string): Promise<void>;

    /**
     * Closes the underlying connection
     */
    close(): Promise<void>;

    /**
     * Event handlers
     */
    on(event: "connected" | "disconnected" | "closed" | "produced" | "throttled" | "error",
        listener: (...args: any[]) => void): this;
    once(event: "connected" | "disconnected" | "closed" | "produced" | "throttled" | "error",
        listener: (...args: any[]) => void): this;
}

export interface IPendingBoxcar {
    documentId: string;
    tenantId: string;
    deferred: Deferred<void>;
    messages: any[];
    partitionId?: number;
}
