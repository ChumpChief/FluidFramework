/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import { IDisposable } from "@fluidframework/common-definitions";
import {
    IFluidHandleContext,
    IFluidSerializer,
    IFluidRouter,
} from "@fluidframework/core-interfaces";
import {
    AttachState,
} from "@fluidframework/container-definitions";
import {
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";
import { IInboundSignalMessage, IProvideFluidDataStoreRegistry } from "@fluidframework/runtime-definitions";
import { IChannel } from ".";

/**
 * Represents the runtime for the data store. Contains helper functions/state of the data store.
 */
export interface IFluidDataStoreRuntime extends
    IFluidRouter,
    EventEmitter,
    IDisposable,
    Partial<IProvideFluidDataStoreRegistry> {

    readonly id: string;

    readonly IFluidSerializer: IFluidSerializer;

    readonly IFluidHandleContext: IFluidHandleContext;

    readonly options: any;

    readonly clientId: string | undefined;

    readonly documentId: string;

    readonly existing: boolean;

    readonly connected: boolean;

    /**
     * Indicates the attachment state of the data store to a host service.
     */
    readonly attachState: AttachState;

    on(
        event: "disconnected" | "dispose" | "leader" | "notleader" | "attaching" | "attached",
        listener: () => void,
    ): this;
    on(event: "op", listener: (message: ISequencedDocumentMessage) => void): this;
    on(event: "signal", listener: (message: IInboundSignalMessage, local: boolean) => void): this;
    on(event: "connected", listener: (clientId: string) => void): this;

    /**
     * Returns the channel with the given id
     */
    getChannel(id: string): Promise<IChannel>;

    /**
     * Creates a new channel of the given type.
     * @param id - ID of the channel to be created.  A unique ID will be generated if left undefined.
     * @param type - Type of the channel.
     */
    createChannel(id: string | undefined, type: string): IChannel;

    /**
     * Bind the channel with the data store runtime. If the runtime
     * is attached then we attach the channel to make it live.
     */
    bindChannel(channel: IChannel): void;

    /**
     * Submits the signal to be sent to other clients.
     * @param type - Type of the signal.
     * @param content - Content of the signal.
     */
    submitSignal(type: string, content: any): void;

    /**
     * Resolves when a local data store is attached.
     */
    waitAttached(): Promise<void>;
}
