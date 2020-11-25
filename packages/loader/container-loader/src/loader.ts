/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import uuid from "uuid";
import { ITelemetryBaseLogger, ITelemetryLogger } from "@fluidframework/common-definitions";
import {
    IFluidObject,
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
import { ChildLogger, DebugLogger, PerformanceEvent } from "@fluidframework/telemetry-utils";
import {
    IDocumentServiceFactory,
    IUrlResolver,
} from "@fluidframework/driver-definitions";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";
import { Container } from "./container";
import { debug } from "./debug";
import { IParsedUrl, parseUrl } from "./utils";

function canUseCache(request: IRequest): boolean {
    if (request.headers === undefined) {
        return true;
    }

    const noCache =
        request.headers[LoaderHeader.cache] === false ||
        request.headers[LoaderHeader.reconnect] === false;

    return !noCache;
}

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
        if (request.url.startsWith("/")) {
            // If no headers are set that require a reload make use of the same object
            const container = await this.containerDeferred.promise;
            return container;
        }

        return this.loader.resolve(request);
    }

    public async request(request: IRequest): Promise<IResponse> {
        const baseRequest = this.baseRequest();
        if (request.url.startsWith("/")) {
            let container: IContainer;
            if (canUseCache(request)) {
                container = await this.containerDeferred.promise;
            } else if (baseRequest === undefined) {
                throw new Error("Base Request is not provided");
            } else {
                container = await this.loader.resolve({ url: baseRequest.url, headers: request.headers });
            }
            return container.request(request);
        }

        return this.loader.request(request);
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
 * Services and properties necessary for creating a loader
 */
export interface ILoaderProps {
    /**
     * The url resolver used by the loader for resolving external urls
     * into Fluid urls such that the container specified by the
     * external url can be loaded.
     */
    readonly urlResolver: IUrlResolver;
    /**
     * The document service factory take the Fluid url provided
     * by the resolved url and constucts all the necessary services
     * for communication with the container's server.
     */
    readonly documentServiceFactory: IDocumentServiceFactory;

    readonly runtimeFactory: IRuntimeFactory;

    /**
     * A property bag of options used by various layers
     * to control features
     */
    readonly options?: any;

    /**
     * Scope is provided to all container and is a set of shared
     * services for container's to integrate with their host environment.
     */
    readonly scope?: IFluidObject;

    /**
     * The logger that all telemetry should be pushed to.
     */
    readonly logger?: ITelemetryBaseLogger;
}

/**
 * Services and properties used by and exposed by the loader
 */
export interface ILoaderServices {
    /**
     * The url resolver used by the loader for resolving external urls
     * into Fluid urls such that the container specified by the
     * external url can be loaded.
     */
    readonly urlResolver: IUrlResolver;
    /**
     * The document service factory take the Fluid url provided
     * by the resolved url and constucts all the necessary services
     * for communication with the container's server.
     */
    readonly documentServiceFactory: IDocumentServiceFactory;

    readonly runtimeFactory: IRuntimeFactory;

    /**
     * A property bag of options used by various layers
     * to control features
     */
    readonly options: any;

    /**
     * Scope is provided to all container and is a set of shared
     * services for container's to integrate with their host environment.
     */
    readonly scope: IFluidObject;

    /**
     * The logger downstream consumers should construct their loggers from
     */
    readonly subLogger: ITelemetryLogger;
}

/**
 * Manages Fluid resource loading
 */
export class Loader extends EventEmitter implements ILoader {
    public readonly services: ILoaderServices;
    private readonly logger: ITelemetryLogger;

    constructor(loaderProps: ILoaderProps) {
        super();
        this.services = {
            urlResolver: loaderProps.urlResolver,
            documentServiceFactory: loaderProps.documentServiceFactory,
            runtimeFactory: loaderProps.runtimeFactory,
            options: loaderProps.options ?? {},
            scope: loaderProps.scope ?? {},
            subLogger: DebugLogger.mixinDebugLogger("fluid:telemetry", loaderProps.logger, { loaderId: uuid() }),
        };
        this.logger = ChildLogger.create(this.services.subLogger, "Loader");
    }

    public get IFluidRouter(): IFluidRouter { return this; }

    public async createDetachedContainer(): Promise<Container> {
        debug(`Container creating in detached state: ${performance.now()} `);

        const container = new Container(
            this,
            this.services.runtimeFactory,
            this.services.documentServiceFactory,
            this.services.options,
            this.services.scope,
            {},
        );
        await container.initializeDetached();
        return container;
    }

    public async rehydrateDetachedContainerFromSnapshot(snapshot: string): Promise<Container> {
        debug(`Container creating in detached state: ${performance.now()} `);

        const container = new Container(
            this,
            this.services.runtimeFactory,
            this.services.documentServiceFactory,
            this.services.options,
            this.services.scope,
            {},
        );
        await container.initializeDetachedFromSnapshot(JSON.parse(snapshot));
        return container;
    }

    public async resolve(request: IRequest): Promise<Container> {
        return PerformanceEvent.timedExecAsync(this.logger, { eventName: "Resolve" }, async () => {
            const resolved = await this.resolveCore(request);
            return resolved.container;
        });
    }

    public async request(request: IRequest): Promise<IResponse> {
        return PerformanceEvent.timedExecAsync(this.logger, { eventName: "Request" }, async () => {
            const resolved = await this.resolveCore(request);
            return resolved.container.request({ url: resolved.parsed.path });
        });
    }

    private async resolveCore(
        request: IRequest,
    ): Promise<{ container: Container; parsed: IParsedUrl }> {
        const resolvedAsFluid = await this.services.urlResolver.resolve(request);
        if (resolvedAsFluid === undefined) {
            throw new Error("Could not resolve");
        }

        // Parse URL into data stores
        const parsed = parseUrl(resolvedAsFluid.url);
        if (parsed === undefined) {
            return Promise.reject(new Error(`Invalid URL ${resolvedAsFluid.url}`));
        }

        request.headers = request.headers ?? {};
        const { fromSequenceNumber } = this.parseHeader(request);

        const container = await this.loadContainer(
            parsed.id,
            this.services.runtimeFactory,
            request,
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

    private canUseCache(request: IRequest): boolean {
        if (request.headers === undefined) {
            return true;
        }

        const noCache =
            request.headers[LoaderHeader.cache] === false ||
            request.headers[LoaderHeader.reconnect] === false ||
            request.headers[LoaderHeader.pause] === true;

        return !noCache;
    }

    private parseHeader(request: IRequest) {
        let fromSequenceNumber = -1;

        request.headers = request.headers ?? {};

        const headerSeqNum = request.headers[LoaderHeader.sequenceNumber];
        if (headerSeqNum !== undefined) {
            fromSequenceNumber = headerSeqNum;
        }

        return {
            canCache: this.canUseCache(request),
            fromSequenceNumber,
        };
    }

    private async loadContainer(
        id: string,
        runtimeFactory: IRuntimeFactory,
        request: IRequest,
        storageUrl: string,
        ordererUrl: string,
        deltaStorageUrl: string,
    ): Promise<Container> {
        const [tenantId, documentId] = id.split("/");
        return Container.load(
            tenantId,
            documentId,
            this,
            runtimeFactory,
            this.services.documentServiceFactory,
            this.services.options,
            this.services.scope,
            request,
            storageUrl,
            ordererUrl,
            deltaStorageUrl,
        );
    }
}
