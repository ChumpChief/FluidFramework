/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IRequest, IResponse, IFluidRouter } from "@fluidframework/core-interfaces";
import {
    IDocumentMessage,
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";
import { IEvent, IEventProvider } from "@fluidframework/common-definitions";
import { IDeltaManager } from "./deltas";
import { ICriticalContainerError, ContainerWarning } from "./error";

/**
 * Events emitted by the Container "upwards" to the Loader and Host
 */
export interface IContainerEvents extends IEvent {
    (event: "readonly", listener: (readonly: boolean) => void): void;
    (event: "connected", listener: (clientId: string) => void);
    /**
     * @param opsBehind - number of ops this client is behind (if present).
     */
    (event: "connect", listener: (opsBehind?: number) => void);
    (event: "disconnected" | "attaching" | "attached", listener: () => void);
    (event: "closed", listener: (error?: ICriticalContainerError) => void);
    (event: "warning", listener: (error: ContainerWarning) => void);
    (event: "op", listener: (message: ISequencedDocumentMessage) => void);
    (event: "pong" | "processTime", listener: (latency: number) => void);
}

/**
 * The Host's view of the Container and its connection to storage
 */
export interface IContainer extends IEventProvider<IContainerEvents>, IFluidRouter {

    /**
     * The Delta Manager supporting the op stream for this Container
     */
    deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>;

    /**
     * Issue a request against the container for a resource.
     * @param request - The request to be issued against the container
     */
    request(request: IRequest): Promise<IResponse>;
}
