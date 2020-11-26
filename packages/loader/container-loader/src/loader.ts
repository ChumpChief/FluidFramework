/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import {
    IRequest,
    IResponse,
    IFluidRouter,
} from "@fluidframework/core-interfaces";
import {
    IContainer,
    ILoader,
    IRuntimeFactory,
    LoaderHeader,
} from "@fluidframework/container-definitions";
import { Deferred, performance } from "@fluidframework/common-utils";
import {
    IDocumentServiceFactory,
    IUrlResolver,
} from "@fluidframework/driver-definitions";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";
import { Container } from "./container";
import { debug } from "./debug";
import { IParsedUrl, parseUrl } from "./utils";

export class RelativeLoader extends EventEmitter implements ILoader {
    // Because the loader is passed to the container during construction we need to resolve the target container
    // after construction.
    private readonly containerDeferred = new Deferred<Container>();

    /**
     * BaseRequest is the original request that triggered the load. This URL is used in case credentials need
     * to be fetched again.
     */
    constructor(
        private readonly loader: ILoader,
        private readonly baseRequest: () => IRequest | undefined,
    ) {
        super();
    }

    public get IFluidRouter(): IFluidRouter { return this; }

    public async resolve(request: IRequest): Promise<IContainer> {
        throw new Error("Not allowed");
    }

    public async request(request: IRequest): Promise<IResponse> {
        throw new Error("Not allowed");
    }

    public async recreateContainer(request: IRequest): Promise<IContainer> {
        const baseRequest = this.baseRequest();
        if (baseRequest === undefined) {
            throw new Error("Base Request is not provided");
        }
        return this.loader.resolve({ url: baseRequest.url, headers: request.headers });
    }

    public async createDetachedContainer(): Promise<Container> {
        throw new Error("Relative loader should not create a detached container");
    }

    public async rehydrateDetachedContainerFromSnapshot(source: string): Promise<Container> {
        throw new Error("Relative loader should not create a detached container from snapshot");
    }

    public resolveContainer(container: Container) {
        this.containerDeferred.resolve(container);
    }
}

/**
 * Manages Fluid resource loading
 */
export class Loader extends EventEmitter implements ILoader {
    constructor(
        private readonly urlResolver: IUrlResolver,
        private readonly documentServiceFactory: IDocumentServiceFactory,
        private readonly runtimeFactory: IRuntimeFactory,
    ) {
        super();
    }

    public get IFluidRouter(): IFluidRouter { return this; }

    public async createDetachedContainer(): Promise<Container> {
        debug(`Container creating in detached state: ${performance.now()} `);

        const container = new Container(
            this,
            this.runtimeFactory,
            this.documentServiceFactory,
            {}, // options
            true, // canReconnect
            undefined, // documentId
            undefined, // originalRequest
        );
        await container.initializeDetached();
        return container;
    }

    public async rehydrateDetachedContainerFromSnapshot(snapshot: string): Promise<Container> {
        debug(`Container creating in detached state: ${performance.now()} `);

        const container = new Container(
            this,
            this.runtimeFactory,
            this.documentServiceFactory,
            {}, // options
            true, // canReconnect
            undefined, // documentId
            undefined, // originalRequest
        );
        await container.initializeDetachedFromSnapshot(JSON.parse(snapshot));
        return container;
    }

    public async resolve(request: IRequest): Promise<Container> {
        const resolved = await this.resolveCore(request);
        return resolved.container;
    }

    public async request(request: IRequest): Promise<IResponse> {
        const resolved = await this.resolveCore(request);
        return resolved.container.request({ url: resolved.parsed.path });
    }

    public async recreateContainer(request: IRequest): Promise<IContainer> {
        throw new Error("Can't recreate from main Loader");
    }

    private async resolveCore(
        request: IRequest,
    ): Promise<{ container: Container; parsed: IParsedUrl }> {
        const resolvedAsFluid = await this.urlResolver.resolve(request);
        if (resolvedAsFluid === undefined) {
            throw new Error("Could not resolve");
        }

        // Parse URL into data stores
        const parsed = parseUrl(resolvedAsFluid.url);
        if (parsed === undefined) {
            return Promise.reject(new Error(`Invalid URL ${resolvedAsFluid.url}`));
        }

        request.headers = request.headers ?? {};
        const fromSequenceNumber = request.headers[LoaderHeader.sequenceNumber] ?? -1;

        const [tenantId, documentId] = parsed.id.split("/");
        const canReconnect = !(request.headers?.[LoaderHeader.reconnect] === false);

        const container = await this.loadContainer(
            tenantId,
            documentId,
            this.runtimeFactory,
            canReconnect,
            resolvedAsFluid.endpoints.storageUrl,
            resolvedAsFluid.endpoints.ordererUrl,
            resolvedAsFluid.endpoints.deltaStorageUrl,
        );

        if (container.deltaManager.lastSequenceNumber <= fromSequenceNumber) {
            await new Promise((resolve, reject) => {
                function opHandler(message: ISequencedDocumentMessage) {
                    if (message.sequenceNumber > fromSequenceNumber) {
                        resolve();
                        container.removeListener("op", opHandler);
                    }
                }

                container.on("op", opHandler);
            });
        }

        return { container, parsed };
    }

    private async loadContainer(
        tenantId: string,
        documentId: string,
        runtimeFactory: IRuntimeFactory,
        canReconnect: boolean,
        storageUrl: string,
        ordererUrl: string,
        deltaStorageUrl: string,
    ): Promise<Container> {
        return Container.load(
            tenantId,
            documentId,
            this,
            runtimeFactory,
            this.documentServiceFactory,
            {}, // options
            canReconnect,
            storageUrl,
            ordererUrl,
            deltaStorageUrl,
        );
    }
}
