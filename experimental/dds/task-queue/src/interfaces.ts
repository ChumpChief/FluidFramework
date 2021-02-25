/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ISharedObject, ISharedObjectEvents } from "@fluidframework/shared-object-base";

export interface ITaskQueueEvents extends ISharedObjectEvents {
    (event: "assigned" | "lost" | "reassigned", listener: (taskId: string) => void);
}

/**
 * Task queue interface
 */

export interface ITaskQueue extends ISharedObject<ITaskQueueEvents> {
    /**
     * Enter the queue, I'm immediately in waiting status
     * @param taskId
     */
    volunteer(taskId: string): void;

    /**
     * Exit the queue, I immediately drop assigned/queued status
     * @param taskId
     */
    abandon(taskId: string): void;

    /**
     * Am I the currently assigned client?
     * @param taskId
     */
    assigned(taskId: string): boolean;

    /**
     * Am I somewhere in the queue already?
     * @param taskId
     */
    queued(taskId: string): boolean;
}
