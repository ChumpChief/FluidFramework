/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IFluidRouter,
} from "@fluidframework/core-interfaces";
import {
    AttachState,
} from "@fluidframework/container-definitions";
import {
    IHelpMessage,
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";
import {
    IContainerRuntimeBase,
    IInboundSignalMessage,
} from "@fluidframework/runtime-definitions";

declare module "@fluidframework/core-interfaces" {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    export interface IFluidObject extends Readonly<Partial<IProvideContainerRuntime>> { }
}

export const IContainerRuntime: keyof IProvideContainerRuntime = "IContainerRuntime";

export interface IProvideContainerRuntime {
    IContainerRuntime: IContainerRuntime;
}

/**
 * Represents the runtime of the container. Contains helper functions/state of the container.
 */
export interface IContainerRuntime extends
    IProvideContainerRuntime,
    IContainerRuntimeBase {
    readonly id: string;
    readonly existing: boolean;
    readonly clientId: string | undefined;
    readonly connected: boolean;
    /**
     * Indicates the attachment state of the container to a host service.
     */
    readonly attachState: AttachState;

    on(event: "batchBegin", listener: (op: ISequencedDocumentMessage) => void): this;
    on(event: "batchEnd", listener: (error: any, op: ISequencedDocumentMessage) => void): this;
    on(event: "op", listener: (message: ISequencedDocumentMessage) => void): this;
    on(event: "signal", listener: (message: IInboundSignalMessage, local: boolean) => void): this;
    on(
        event: "dirtyDocument" | "disconnected" | "dispose" | "savedDocument" | "leader" | "notleader",
        listener: () => void): this;
    on(event: "connected", listener: (clientId: string) => void): this;
    on(event: "localHelp", listener: (message: IHelpMessage) => void): this;
    /**
     * Returns the runtime of the data store.
     * @param id - Id supplied during creating the data store.
     * @param wait - True if you want to wait for it.
     */
    getRootDataStore(id: string, wait?: boolean): Promise<IFluidRouter>;

    /**
     * Creates root data store in container. Such store is automatically bound to container, and thus is
     * attached to storage when/if container is attached to storage. Such stores are never garbage collected
     * and can be found / loaded by name.
     * Majority of data stores in container should not be roots, and should be reachable (directly or indirectly)
     * through one of the roots.
     * @param pkg - Package name of the data store factory
     * @param rootDataStoreId - data store ID. IDs naming space is global in container. If collision on name occurs,
     * it results in container corruption - loading this file after that will always result in error.
     */
    createRootDataStore(pkg: string | string[], rootDataStoreId: string): Promise<IFluidRouter>;

    /**
     * Get an absolute url for a provided container-relative request.
     * Returns undefined if the container isn't attached to storage.
     * @param relativeUrl - A relative request within the container
     */
    getAbsoluteUrl(relativeUrl: string): Promise<string | undefined>;
}
