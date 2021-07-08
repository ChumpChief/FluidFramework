/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { v4 as uuid } from "uuid";
import { ITelemetryBaseLogger, ITelemetryLogger } from "@fluidframework/common-definitions";
import {
    IFluidObject,
    IRequest,
    IResponse,
    IFluidRouter,
    IFluidCodeDetails,
} from "@fluidframework/core-interfaces";
import {
    ICodeLoader,
    IContainer,
    IHostLoader,
    ILoader,
    ILoaderOptions,
    IProxyLoaderFactory,
    LoaderHeader,
} from "@fluidframework/container-definitions";
import { performance } from "@fluidframework/common-utils";
import { ChildLogger, DebugLogger, PerformanceEvent } from "@fluidframework/telemetry-utils";
import {
    IDocumentServiceFactory,
    IFluidResolvedUrl,
    IUrlResolver,
} from "@fluidframework/driver-definitions";
import {
    ensureFluidResolvedUrl,
    MultiUrlResolver,
    MultiDocumentServiceFactory,
} from "@fluidframework/driver-utils";
import { Container } from "./container";
import { debug } from "./debug";
import { IParsedUrl, parseUrl } from "./utils";

export class RelativeLoader implements ILoader {
    constructor(
        private readonly container: Container,
        private readonly loader: ILoader | undefined,
    ) { }

    public get IFluidRouter(): IFluidRouter { return this; }

    public async resolve(request: IRequest): Promise<IContainer> {
        if (request.url.startsWith("/")) {
            const resolvedUrl = this.container.resolvedUrl;
            ensureFluidResolvedUrl(resolvedUrl);
            const container = await Container.load(
                this.loader as Loader,
                {
                    canReconnect: request.headers?.[LoaderHeader.reconnect],
                    clientDetailsOverride: request.headers?.[LoaderHeader.clientDetails],
                    resolvedUrl: {...resolvedUrl},
                },
            );
            return container;
        }

        if (this.loader === undefined) {
            throw new Error("Cannot resolve external containers");
        }
        return this.loader.resolve(request);
    }

    public async request(request: IRequest): Promise<IResponse> {
        if (request.url.startsWith("/")) {
            const container = await this.resolve(request);
            return container.request(request);
        }

        if (this.loader === undefined) {
            return {
                status: 404,
                value: "Cannot request external containers",
                mimeType: "plain/text",
            };
        }
        return this.loader.request(request);
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
    /**
     * The code loader handles loading the necessary code
     * for running a container once it is loaded.
     */
    readonly codeLoader: ICodeLoader;

    /**
     * A property bag of options used by various layers
     * to control features
     */
    readonly options?: ILoaderOptions;

    /**
     * Scope is provided to all container and is a set of shared
     * services for container's to integrate with their host environment.
     */
    readonly scope?: IFluidObject;

    /**
     * Proxy loader factories for loading containers via proxy in other contexts,
     * like web workers, or worker threads.
     */
    readonly proxyLoaderFactories?: Map<string, IProxyLoaderFactory>;

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
    /**
     * The code loader handles loading the necessary code
     * for running a container once it is loaded.
     */
    readonly codeLoader: ICodeLoader;

    /**
     * A property bag of options used by various layers
     * to control features
     */
    readonly options: ILoaderOptions;

    /**
     * Scope is provided to all container and is a set of shared
     * services for container's to integrate with their host environment.
     */
    readonly scope: IFluidObject;

    /**
     * Proxy loader factories for loading containers via proxy in other contexts,
     * like web workers, or worker threads.
     */
    readonly proxyLoaderFactories: Map<string, IProxyLoaderFactory>;

    /**
     * The logger downstream consumers should construct their loggers from
     */
    readonly subLogger: ITelemetryLogger;
}

/**
 * Manages Fluid resource loading
 */
export class Loader implements IHostLoader {
    public readonly services: ILoaderServices;
    private readonly logger: ITelemetryLogger;

    constructor(loaderProps: ILoaderProps) {
        const scope = { ...loaderProps.scope };
        if (loaderProps.options?.provideScopeLoader !== false) {
            scope.ILoader = this;
        }

        this.services = {
            urlResolver: MultiUrlResolver.create(loaderProps.urlResolver),
            documentServiceFactory: MultiDocumentServiceFactory.create(loaderProps.documentServiceFactory),
            codeLoader: loaderProps.codeLoader,
            options: loaderProps.options ?? {},
            scope,
            subLogger: DebugLogger.mixinDebugLogger("fluid:telemetry", loaderProps.logger, { all:{loaderId: uuid()} }),
            proxyLoaderFactories: loaderProps.proxyLoaderFactories ?? new Map<string, IProxyLoaderFactory>(),
        };
        this.logger = ChildLogger.create(this.services.subLogger, "Loader");
    }

    public get IFluidRouter(): IFluidRouter { return this; }

    public async createDetachedContainer(codeDetails: IFluidCodeDetails): Promise<Container> {
        debug(`Container creating in detached state: ${performance.now()} `);

        return Container.createDetached(
            this,
            codeDetails,
        );
    }

    public async rehydrateDetachedContainerFromSnapshot(snapshot: string): Promise<Container> {
        throw new Error("Not implemented");
    }

    public async resolve(request: IRequest): Promise<Container> {
        const eventName = "Resolve";
        return PerformanceEvent.timedExecAsync(this.logger, { eventName }, async () => {
            const resolved = await this.resolveCore(request);
            return resolved.container;
        });
    }

    public async request(request: IRequest): Promise<IResponse> {
        return PerformanceEvent.timedExecAsync(this.logger, { eventName: "Request" }, async () => {
            const resolved = await this.resolveCore(request);
            return resolved.container.request({ url: `${resolved.parsed.path}${resolved.parsed.query}` });
        });
    }

    private async resolveCore(request: IRequest): Promise<{ container: Container; parsed: IParsedUrl }> {
        const resolvedAsFluid = await this.services.urlResolver.resolve(request);
        ensureFluidResolvedUrl(resolvedAsFluid);

        // Parse URL into data stores
        const parsed = parseUrl(resolvedAsFluid.url);
        if (parsed === undefined) {
            throw new Error(`Invalid URL ${resolvedAsFluid.url}`);
        }

        const { fromSequenceNumber } = this.parseHeader(request);

        const container = await this.loadContainer(
            request,
            resolvedAsFluid,
        );

        await container.waitUntilOpProcessed(fromSequenceNumber);

        return { container, parsed };
    }

    private parseHeader(request: IRequest) {
        let fromSequenceNumber = -1;

        request.headers = request.headers ?? {};

        const headerSeqNum = request.headers[LoaderHeader.sequenceNumber];
        if (headerSeqNum !== undefined) {
            fromSequenceNumber = headerSeqNum;
        }

        return {
            fromSequenceNumber,
        };
    }

    private async loadContainer(
        request: IRequest,
        resolved: IFluidResolvedUrl,
    ): Promise<Container> {
        return Container.load(
            this,
            {
                canReconnect: request.headers?.[LoaderHeader.reconnect],
                clientDetailsOverride: request.headers?.[LoaderHeader.clientDetails],
                resolvedUrl: resolved,
            },
        );
    }
}
