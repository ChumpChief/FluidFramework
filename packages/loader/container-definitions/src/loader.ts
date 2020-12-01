/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IRequest,
    IResponse,
    IFluidRouter,
} from "@fluidframework/core-interfaces";
import {
    IClientDetails,
    IQuorum,
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";
import { IEvent, IEventProvider } from "@fluidframework/common-definitions";
import { IDocumentService } from "@fluidframework/driver-definitions";
import { ICriticalContainerError } from "./error";
import { AttachState, IRuntimeFactory } from "./runtime";

/**
 * Code loading interface
 */
export interface ICodeLoader {
    /**
     * Loads the package specified by code details and returns a promise to its entry point exports.
     */
    load(): Promise<IRuntimeFactory>;
}

/**
 * Events emitted by the Container "upwards" to the Loader and Host
 */
export interface IContainerEvents extends IEvent {
    (event: "connected", listener: (clientId: string) => void);
    /**
     * @param opsBehind - number of ops this client is behind (if present).
     */
    (event: "connect", listener: (opsBehind?: number) => void);
    (event: "disconnected" | "attaching" | "attached", listener: () => void);
    (event: "closed", listener: (error?: ICriticalContainerError) => void);
    (event: "op", listener: (message: ISequencedDocumentMessage) => void);
}

/**
 * The Host's view of the Container and its connection to storage
 */
export interface IContainer extends IEventProvider<IContainerEvents>, IFluidRouter {
    /**
     * The collection of write clients which were connected as of the current sequence number.
     * Also contains a map of key-value pairs that must be agreed upon by all clients before being accepted.
     */
    getQuorum(): IQuorum;

    /**
     * Indicates the attachment state of the container to a host service.
     */
    readonly attachState: AttachState;

    /**
     * Attaches the Container to the Container specified by the given Request.
     *
     * TODO - in the case of failure options should give a retry policy. Or some continuation function
     * that allows attachment to a secondary document.
     */
    attach(documentService: IDocumentService): Promise<void>

    /**
     * Issue a request against the container for a resource.
     * @param request - The request to be issued against the container
     */
    request(request: IRequest): Promise<IResponse>;
}

/**
 * The Host's view of the Loader, used for loading Containers
 */
export interface ILoader extends IFluidRouter {
    /**
     * Resolves the resource specified by the URL + headers contained in the request object
     * to the underlying container that will resolve the request.
     *
     * An analogy for this is resolve is a DNS resolve of a Fluid container. Request then executes
     * a request against the server found from the resolve step.
     */
    resolve(request: IRequest): Promise<IContainer>;

    /**
     * Creates a new container using the specified chaincode but in an unattached state. While unattached all
     * updates will only be local until the user explicitly attaches the container to a service provider.
     */
    createDetachedContainer(): Promise<IContainer>;

    /**
     * Creates a new container using the specified snapshot but in an unattached state. While unattached all
     * updates will only be local until the user explicitly attaches the container to a service provider.
     */
    rehydrateDetachedContainerFromSnapshot(snapshot: string): Promise<IContainer>;
}

/**
 * Accepted header keys for requests coming to the Loader
 */
export enum LoaderHeader {
    /**
     * Use cache for this container. If true, we will load a container from cache if one with the same id/version exists
     * or create a new container and cache it if it does not. If false, always load a new container and don't cache it.
     * Currently only used to opt-out of caching, as it will default to true but will be false (even if specified as
     * true) if the reconnect header is false or the pause header is true, since these containers should not be cached.
     */
    cache = "fluid-cache",
    clientDetails = "fluid-client-details",
    reconnect = "fluid-reconnect",
    sequenceNumber = "fluid-sequence-number",
}

/**
 * Set of Request Headers that the Loader understands and may inspect or modify
 */
export interface ILoaderHeader {
    [LoaderHeader.cache]: boolean;
    [LoaderHeader.clientDetails]: IClientDetails;
    [LoaderHeader.sequenceNumber]: number;
    [LoaderHeader.reconnect]: boolean;
}

declare module "@fluidframework/core-interfaces" {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    export interface IRequestHeader extends Partial<ILoaderHeader> { }
}
