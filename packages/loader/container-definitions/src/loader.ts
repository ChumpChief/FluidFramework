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

/**
 * Events emitted by the Container "upwards" to the Loader and Host
 */
export interface IContainerEvents extends IEvent {
    (event: "connected", listener: (clientId: string) => void);
    (event: "disconnected" | "attaching" | "attached", listener: () => void);
    (event: "op", listener: (message: ISequencedDocumentMessage) => void);
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
