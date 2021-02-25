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
 * Description of a cell delta operation
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
 * The SharedCell distributed data structure can be used to store a single serializable value.
 *
 * @remarks
 * ### Creation
 *
 * To create a `SharedCell`, call the static create method:
 *
 * ```typescript
 * const myCell = SharedCell.create(this.runtime, id);
 * ```
 *
 * ### Usage
 *
 * The value stored in the cell can be set with the `.set()` method and retrieved with the `.get()` method:
 *
 * ```typescript
 * myCell.set(3);
 * console.log(myCell.get()); // 3
 * ```
 *
 * The value must only be plain JS objects or `SharedObject` handles (e.g. to another DDS or Fluid object).
 * In collaborative scenarios, the value is settled with a policy of _last write wins_.
 *
 * The `.delete()` method will delete the stored value from the cell:
 *
 * ```typescript
 * myCell.delete();
 * console.log(myCell.get()); // undefined
 * ```
 *
 * The `.empty()` method will check if the value is undefined.
 *
 * ```typescript
 * if (myCell.empty()) {
 *   // myCell.get() will return undefined
 * } else {
 *   // myCell.get() will return a non-undefined value
 * }
 * ```
 *
 * ### Eventing
 *
 * `SharedCell` is an `EventEmitter`, and will emit events when other clients make modifications. You should
 * register for these events and respond appropriately as the data is modified. `valueChanged` will be emitted
 * in response to a `set`, and `delete` will be emitted in response to a `delete`.
 */
export class TaskQueue extends SharedObject<ITaskQueueEvents> implements ITaskQueue {
    /**
     * Create a new shared cell
     *
     * @param runtime - data store runtime the new shared map belongs to
     * @param id - optional name of the shared map
     * @returns newly create shared map (but not attached yet)
     */
    public static create(runtime: IFluidDataStoreRuntime, id?: string) {
        return runtime.createChannel(id, TaskQueueFactory.Type) as TaskQueue;
    }

    /**
     * Get a factory for SharedCell to register with the data store.
     *
     * @returns a factory that creates and load SharedCell
     */
    public static getFactory(): IChannelFactory {
        return new TaskQueueFactory();
    }

    /**
     * Mapping of taskId to a queue of clientIds that are waiting on the task.
     */
    private taskQueues: Map<string, string[]> | undefined;

    /**
     * taskIds for tasks that we've sent a volunteer for but have not yet been ack'd.
     */
    private readonly pendingTaskQueues: Set<string> = new Set();

    /**
     * Constructs a new shared cell. If the object is non-local an id and service interfaces will
     * be provided
     *
     * @param runtime - data store runtime the shared map belongs to
     * @param id - optional name of the shared map
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
        const currentAssignee = this.taskQueues?.get(taskId)?.[0];
        return (currentAssignee !== undefined && currentAssignee === this.runtime.clientId);
    }

    public queued(taskId: string) {
        assert(this.runtime.clientId !== undefined); // TODO, handle disconnected case
        const clientQueue = this.taskQueues?.get(taskId);
        // If we have no queue for the taskId, then no one has signed up for it.
        return clientQueue !== undefined && clientQueue.includes(this.runtime.clientId);
    }

    /**
     * Create a snapshot for the cell
     *
     * @returns the snapshot of the current state of the cell
     */
    protected snapshotCore(serializer: IFluidSerializer): ITree {
        const content = this.taskQueues !== undefined
            ? [...this.taskQueues?.entries()]
            : [];

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
        this.taskQueues = new Map(content);
    }

    /**
     * Initialize a local instance of cell
     */
    protected initializeLocalCore() {
        this.taskQueues = new Map();
    }

    /**
     * Process the cell value on register
     */
    protected registerCore() { }

    /**
     * Call back on disconnect
     */
    protected onDisconnect() { }

    /**
     * Process a cell operation
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
                // TODO
                // case "volunteer":
                //     break;

                // case "abandon":
                //     break;

                default:
                    throw new Error("Unknown operation");
            }
        }
    }
}
