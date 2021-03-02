/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";

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

    private readonly opWatcher: EventEmitter = new EventEmitter();
    private readonly queueWatcher: EventEmitter = new EventEmitter();

    /**
     * Constructs a new task queue. If the object is non-local an id and service interfaces will
     * be provided
     *
     * @param runtime - data store runtime the task queue belongs to
     * @param id - optional name of the task queue
     */
    constructor(id: string, runtime: IFluidDataStoreRuntime, attributes: IChannelAttributes) {
        super(id, runtime, attributes);

        this.opWatcher.on("volunteer", (taskId: string, clientId: string) => {
            this.addClientToQueue(taskId, clientId);
        });

        this.opWatcher.on("abandon", (taskId: string, clientId: string) => {
            this.removeClientFromQueue(taskId, clientId);
        });

        runtime.getQuorum().on("removeMember", (clientId: string) => {
            console.log("Quorum alerts removal", clientId);
            this.removeClientFromAllQueues(clientId);
        });
    }

    // TODO Remove or hide from interface, this is just for debugging
    public getTaskQueues() {
        return this.taskQueues;
    }

    private submitVolunteerOp(taskId: string) {
        const op: ITaskQueueVolunteerOperation = {
            type: "volunteer",
            taskId,
        };
        this.pendingTaskQueues.add(taskId);
        console.log("Queueing self", taskId, this.runtime.clientId);
        this.submitLocalMessage(op);
    }

    public async lockTask(taskId: string) {
        if (this.haveTaskLock(taskId)) {
            return;
        }

        const lockAcquireP = new Promise<void>((res, rej) => {
            const checkIfAcquiredLock = (eventTaskId: string) => {
                if (eventTaskId !== taskId) {
                    return;
                }

                if (this.haveTaskLock(taskId)) {
                    this.queueWatcher.off("queueChange", checkIfAcquiredLock);
                    res();
                } else if (!this.queued(taskId)) {
                    this.queueWatcher.off("queueChange", checkIfAcquiredLock);
                    rej(new Error(`Removed from queue: ${taskId}`));
                }
            };
            this.queueWatcher.on("queueChange", checkIfAcquiredLock);
        });

        if (!this.queued(taskId)) {
            // TODO What should be done if we are not attached?  Treat like auto-ack?
            this.submitVolunteerOp(taskId);
        }

        return lockAcquireP;
    }

    public abandon(taskId: string) {
        // Nothing to do if we're not at least trying to get the lock.
        if (!this.queued(taskId)) {
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

    public haveTaskLock(taskId: string) {
        const currentAssignee = this.taskQueues.get(taskId)?.[0];
        return (currentAssignee !== undefined && currentAssignee === this.runtime.clientId);
    }

    public queued(taskId: string) {
        assert(this.runtime.clientId !== undefined); // TODO, handle disconnected/detached case
        const clientQueue = this.taskQueues.get(taskId);
        // If we have no queue for the taskId, then no one has signed up for it.
        return (clientQueue !== undefined && clientQueue.includes(this.runtime.clientId))
            || this.pendingTaskQueues.has(taskId);
    }

    /**
     * Create a snapshot for the task queue
     *
     * @returns the snapshot of the current state of the task queue
     */
    protected snapshotCore(serializer: IFluidSerializer): ITree {
        const content = [...this.taskQueues.entries()];
        console.log("Generating snapshot", content);

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
        this.scrubClientsNotInQuorum();
        console.log("loadCore complete", this.taskQueues);
    }

    protected initializeLocalCore() { }

    protected registerCore() { }

    protected onDisconnect() {
        // TODO knock ourselves out of the queues here?
    }

    /**
     * Process a task queue operation
     *
     * @param message - the message to prepare
     * @param local - whether the message was sent by the local client
     * @param localOpMetadata - For local client messages, this is the metadata that was submitted with the message.
     * For messages from a remote client, this will be undefined.
     */
    protected processCore(message: ISequencedDocumentMessage, local: boolean, localOpMetadata: unknown) {
        if (message.type === MessageType.Operation) {
            const op = message.contents as ITaskQueueOperation;
            console.log("Processing incoming", op.taskId, message.clientId);

            switch (op.type) {
                case "volunteer":
                    this.opWatcher.emit("volunteer", op.taskId, message.clientId);
                    break;

                case "abandon":
                    this.opWatcher.emit("abandon", op.taskId, message.clientId);
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
        console.log(`Added ${clientId}`, clientQueue);

        // Clean up our pending state if needed
        if (clientId === this.runtime.clientId) {
            this.pendingTaskQueues.delete(taskId);
        }

        // TODO remove
        this.emit("changed");
        this.queueWatcher.emit("queueChange", taskId);
    }

    private removeClientFromQueue(taskId: string, clientId: string) {
        const clientQueue = this.taskQueues.get(taskId);
        if (clientQueue !== undefined) {
            const clientIdIndex = clientQueue.indexOf(clientId);
            if (clientIdIndex !== -1) {
                clientQueue.splice(clientIdIndex, 1);
                console.log(`Removed ${clientId}`, clientQueue);
                // Clean up the queue if there are no more clients in it.
                if (clientQueue.length === 0) {
                    this.taskQueues.delete(taskId);
                }
            }
        }

        if (clientId === this.runtime.clientId) {
            this.pendingTaskQueues.delete(taskId);
        }

        // TODO remove
        this.emit("changed");
        this.queueWatcher.emit("queueChange", taskId);
    }

    private removeClientFromAllQueues(clientId: string) {
        if (clientId === this.runtime.clientId) {
            // TODO is this correct?
            this.pendingTaskQueues.clear();
        }
        for (const taskId of this.taskQueues.keys()) {
            this.removeClientFromQueue(taskId, clientId);
        }
    }

    // This seems like it should be unnecessary if we can trust to receive the join/leave messages and
    // also have an accurate snapshot.
    private scrubClientsNotInQuorum() {
        const quorum = this.runtime.getQuorum();
        for (const [taskId, clientQueue] of this.taskQueues) {
            const filteredClientQueue = clientQueue.filter((clientId) => quorum.getMember(clientId) !== undefined);
            if (clientQueue.length !== filteredClientQueue.length) {
                if (filteredClientQueue.length === 0) {
                    this.taskQueues.delete(taskId);
                } else {
                    this.taskQueues.set(taskId, filteredClientQueue);
                }
                // TODO remove
                this.emit("changed");
                this.queueWatcher.emit("queueChange", taskId);
            }
        }
    }
}
