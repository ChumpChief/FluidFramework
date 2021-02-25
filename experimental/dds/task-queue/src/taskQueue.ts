/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert, bufferToString } from "@fluidframework/common-utils";
import { IFluidSerializer } from "@fluidframework/core-interfaces";

import {
    FileMode,
    ISequencedDocumentMessage,
    ITree,
    MessageType,
    TreeEntry,
} from "@fluidframework/protocol-definitions";
import {
    IChannelAttributes,
    IFluidDataStoreRuntime,
    IChannelStorageService,
    IChannelFactory,
} from "@fluidframework/datastore-definitions";
import { SharedObject } from "@fluidframework/shared-object-base";
import { TaskQueueFactory } from "./taskQueueFactory";
import { ITaskQueue, ITaskQueueEvents } from "./interfaces";

/**
 * Description of a task queue operation
 */
type ITaskQueueOperation = ITaskQueueVolunteerOperation | ITaskQueueAbandonOperation;

interface ITaskQueueVolunteerOperation {
    type: "volunteer";
    taskId: string;
}

interface ITaskQueueAbandonOperation {
    type: "abandon";
    taskId: string;
}

const snapshotFileName = "header";

/**
 * The TaskQueue distributed data structure tracks queues of clients that want to exclusively run a task.
 *
 * @remarks
 * ### Creation
 *
 * To create a `TaskQueue`, call the static create method:
 *
 * ```typescript
 * const myQueue = TaskQueue.create(this.runtime, id);
 * ```
 *
 * ### Usage
 *
 * TODO
 *
 * ### Eventing
 *
 * `TaskQueue` is an `EventEmitter`, and will emit events when other clients make modifications. You should
 * register for these events and respond appropriately as the data is modified. TODO details.
 */
export class TaskQueue extends SharedObject<ITaskQueueEvents> implements ITaskQueue {
    /**
     * Create a new TaskQueue
     *
     * @param runtime - data store runtime the new task queue belongs to
     * @param id - optional name of the task queue
     * @returns newly create task queue (but not attached yet)
     */
    public static create(runtime: IFluidDataStoreRuntime, id?: string) {
        return runtime.createChannel(id, TaskQueueFactory.Type) as TaskQueue;
    }

    /**
     * Get a factory for TaskQueue to register with the data store.
     *
     * @returns a factory that creates and load TaskQueue
     */
    public static getFactory(): IChannelFactory {
        return new TaskQueueFactory();
    }

    /**
     * Mapping of taskId to a queue of clientIds that are waiting on the task.
     */
    private readonly taskQueues: Map<string, string[]> = new Map();

    /**
     * taskIds for tasks that we've sent a volunteer for but have not yet been ack'd.
     */
    private readonly pendingTaskQueues: Set<string> = new Set();

    /**
     * Constructs a new task queue. If the object is non-local an id and service interfaces will
     * be provided
     *
     * @param runtime - data store runtime the task queue belongs to
     * @param id - optional name of the task queue
     */
    constructor(id: string, runtime: IFluidDataStoreRuntime, attributes: IChannelAttributes) {
        super(id, runtime, attributes);
    }

    public volunteer(taskId: string) {
        // Return if we're already queued or waiting to queue.
        if (this.queued(taskId) || this.pendingTaskQueues.has(taskId)) {
            return;
        }
        // TODO: Can't volunteer if detached?  Or maybe should just treat as auto-ack?
        if (!this.isAttached()) {
            return;
        }
        const op: ITaskQueueVolunteerOperation = {
            type: "volunteer",
            taskId,
        };
        this.pendingTaskQueues.add(taskId);
        this.submitLocalMessage(op);
    }

    public abandon(taskId: string) {
        // Return if we're not queued or waiting to queue.
        if (!this.queued(taskId) && !this.pendingTaskQueues.has(taskId)) {
            return;
        }
        // TODO: Can't abandon if detached?  Or maybe should just treat as auto-ack?
        if (!this.isAttached()) {
            return;
        }
        const op: ITaskQueueAbandonOperation = {
            type: "abandon",
            taskId,
        };
        this.submitLocalMessage(op);
    }

    public assigned(taskId: string) {
        const currentAssignee = this.taskQueues.get(taskId)?.[0];
        return (currentAssignee !== undefined && currentAssignee === this.runtime.clientId);
    }

    public queued(taskId: string) {
        assert(this.runtime.clientId !== undefined); // TODO, handle disconnected case
        const clientQueue = this.taskQueues.get(taskId);
        // If we have no queue for the taskId, then no one has signed up for it.
        return clientQueue !== undefined && clientQueue.includes(this.runtime.clientId);
    }

    /**
     * Create a snapshot for the task queue
     *
     * @returns the snapshot of the current state of the task queue
     */
    protected snapshotCore(serializer: IFluidSerializer): ITree {
        const content = [...this.taskQueues.entries()];

        // And then construct the tree for it
        const tree: ITree = {
            entries: [
                {
                    mode: FileMode.File,
                    path: snapshotFileName,
                    type: TreeEntry.Blob,
                    value: {
                        contents: JSON.stringify(content),
                        encoding: "utf-8",
                    },
                },
            ],
        };

        return tree;
    }

    /**
     * {@inheritDoc @fluidframework/shared-object-base#SharedObject.loadCore}
     */
    protected async loadCore(storage: IChannelStorageService): Promise<void> {
        const blob = await storage.readBlob(snapshotFileName);
        const rawContent = bufferToString(blob, "utf8");
        const content = rawContent !== undefined
            ? JSON.parse(rawContent) as [string, string[]][]
            : [];

        content.forEach(([taskId, clientIdQueue]) => {
            this.taskQueues.set(taskId, clientIdQueue);
        });
    }

    protected initializeLocalCore() { }

    protected registerCore() { }

    protected onDisconnect() { }

    /**
     * Process a task queue operation
     *
     * @param message - the message to prepare
     * @param local - whether the message was sent by the local client
     * @param localOpMetadata - For local client messages, this is the metadata that was submitted with the message.
     * For messages from a remote client, this will be undefined.
     */
    protected processCore(message: ISequencedDocumentMessage, local: boolean, localOpMetadata: unknown) {
        if (message.type === MessageType.Operation && !local) {
            const op = message.contents as ITaskQueueOperation;

            switch (op.type) {
                case "volunteer":
                    this.addClientToQueue(op.taskId, message.clientId);
                    break;

                case "abandon":
                    this.removeClientFromQueue(op.taskId, message.clientId);
                    break;

                default:
                    throw new Error("Unknown operation");
            }
        }
    }

    private addClientToQueue(taskId: string, clientId: string) {
        // Create the queue if it doesn't exist, and push the client on the back.
        let clientQueue = this.taskQueues.get(taskId);
        if (clientQueue === undefined) {
            clientQueue = [];
            this.taskQueues.set(taskId, clientQueue);
        }
        clientQueue.push(clientId);

        // Clean up our pending state if needed
        if (clientId === this.runtime.clientId) {
            this.pendingTaskQueues.delete(taskId);
        }
    }

    private removeClientFromQueue(taskId: string, clientId: string) {
        const clientQueue = this.taskQueues.get(taskId);
        if (clientQueue !== undefined) {
            const clientIdIndex = clientQueue.indexOf(clientId);
            if (clientIdIndex !== -1) {
                clientQueue.splice(clientIdIndex, 1);
                // Clean up the queue if there are no more clients in it.
                if (clientQueue.length === 0) {
                    this.taskQueues.delete(taskId);
                }
            }
        }

        this.pendingTaskQueues.delete(taskId);
    }
}
