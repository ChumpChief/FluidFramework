/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IChannelAttributes,
    IFluidDataStoreRuntime,
    IChannelServices,
    IChannelFactory,
} from "@fluidframework/datastore-definitions";
import { TaskQueue } from "./taskQueue";
import { ITaskQueue } from "./interfaces";
import { pkgVersion } from "./packageVersion";

/**
 * The factory that defines the map
 */
export class TaskQueueFactory implements IChannelFactory {
    public static readonly Type = "https://graph.microsoft.com/types/task-queue";

    public static readonly Attributes: IChannelAttributes = {
        type: TaskQueueFactory.Type,
        snapshotFormatVersion: "0.1",
        packageVersion: pkgVersion,
    };

    public get type() {
        return TaskQueueFactory.Type;
    }

    public get attributes() {
        return TaskQueueFactory.Attributes;
    }

    /**
     * {@inheritDoc @fluidframework/datastore-definitions#IChannelFactory.load}
     */
    public async load(
        runtime: IFluidDataStoreRuntime,
        id: string,
        services: IChannelServices,
        attributes: IChannelAttributes): Promise<ITaskQueue> {
        const cell = new TaskQueue(id, runtime, attributes);
        await cell.load(services);
        return cell;
    }

    public create(document: IFluidDataStoreRuntime, id: string): ITaskQueue {
        const cell = new TaskQueue(id, document, this.attributes);
        cell.initializeLocal();
        return cell;
    }
}
