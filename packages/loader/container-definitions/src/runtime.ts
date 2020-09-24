/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IRequest,
    IResponse,
} from "@fluidframework/core-interfaces";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    ISequencedDocumentMessage,
    ITree,
} from "@fluidframework/protocol-definitions";

// Represents the attachment state of the entity.
export enum AttachState {
    Detached = "Detached",
    Attaching = "Attaching",
    Attached = "Attached",
}

// Represents the bind state of the entity.
export enum BindState {
    NotBound = "NotBound",
    Binding = "Binding",
    Bound = "Bound",
}

/**
 * Represents the data that will be preserved from the previous IRuntime during a context reload.
 */
export interface IRuntimeState {
    snapshot?: ITree,
    state?: unknown,
}

/**
 * The IRuntime represents an instantiation of a code package within a Container.
 * Primarily held by the ContainerContext to be able to interact with the running instance of the Container.
 */
export interface IRuntime {

    /**
     * Executes a request against the runtime
     */
    request(request: IRequest): Promise<IResponse>;

    /**
     * Notifies the runtime of a change in the connection state
     */
    setConnectionState(connected: boolean);

    /**
     * Processes the given op (message)
     */
    process(message: ISequencedDocumentMessage, local: boolean);

    /**
     * Propagate the container state when container is attaching or attached.
     * @param attachState - State of the container.
     */
    setAttachState(attachState: AttachState.Attaching | AttachState.Attached): void;
}

/**
 * The ContainerContext is a proxy standing between the Container and the Container's IRuntime.
 * This allows the Container to terminate the connection to the IRuntime.
 *
 * Specifically, there is an event on Container, onContextChanged, which mean a new code proposal has been loaded,
 * so the old IRuntime is no longer valid, as its ContainerContext has been revoked,
 * and the Container has created a new ContainerContext.
 */
export interface IContainerContext {
    readonly existing: boolean;
    readonly clientId: string | undefined;
    readonly storage: IDocumentStorageService;
    readonly connected: boolean;
    readonly submitFn: (contents: any) => number;
}

export const IRuntimeFactory: keyof IProvideRuntimeFactory = "IRuntimeFactory";

export interface IProvideRuntimeFactory {
    readonly IRuntimeFactory: IRuntimeFactory;
}

/**
 * Exported module definition
 *
 * Provides the entry point for the ContainerContext to load the proper IRuntime
 * to start up the running instance of the Container.
 */
export interface IRuntimeFactory extends IProvideRuntimeFactory {
    /**
     * Instantiates a new IRuntime for the given IContainerContext to proxy to
     * This is the main entry point to the Container's business logic
     */
    instantiateRuntime(
        existing: boolean,
        submitFn: (contents: any) => number,
        storage: IDocumentStorageService,
    ): Promise<IRuntime>;
}
