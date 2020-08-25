/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import {
    IRequest,
    IResponse,
} from "@fluidframework/core-interfaces";
import {
    ICodeLoader,
    ILoader,
    IProxyLoaderFactory,
    LoaderHeader,
    IFluidCodeDetails,
} from "@fluidframework/container-definitions";
import { performanceNow } from "@fluidframework/common-utils";
import {
    IDocumentServiceFactory,
    IFluidResolvedUrl,
    IResolvedUrl,
    IUrlResolver,
} from "@fluidframework/driver-definitions";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";
import {
    ensureFluidResolvedUrl,
    MultiUrlResolver,
    MultiDocumentServiceFactory,
} from "@fluidframework/driver-utils";
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

function createCachedResolver(resolver: IUrlResolver) {
    const cacheResolver = Object.create(resolver) as IUrlResolver;
    const resolveCache = new Map<string, Promise<IResolvedUrl | undefined>>();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    cacheResolver.resolve = async (request: IRequest): Promise<IResolvedUrl | undefined> => {
        if (!canUseCache(request)) {
            return resolver.resolve(request);
        }
        if (!resolveCache.has(request.url)) {
            resolveCache.set(request.url, resolver.resolve(request));
        }

        return resolveCache.get(request.url);
    };
    return cacheResolver;
}

/**
 * Manages Fluid resource loading
 */
export class Loader extends EventEmitter implements ILoader {
    private readonly containers = new Map<string, Promise<Container>>();
    private readonly resolver: IUrlResolver;
    private readonly documentServiceFactory: IDocumentServiceFactory;

    constructor(
        resolver: IUrlResolver | IUrlResolver[],
        documentServiceFactory: IDocumentServiceFactory | IDocumentServiceFactory[],
        private readonly codeLoader: ICodeLoader,
        private readonly proxyLoaderFactories: Map<string, IProxyLoaderFactory>,
    ) {
        super();

        this.resolver = createCachedResolver(MultiUrlResolver.create(resolver));
        this.documentServiceFactory = MultiDocumentServiceFactory.create(documentServiceFactory);
    }

    public async createDetachedContainer(source: IFluidCodeDetails): Promise<Container> {
        debug(`Container creating in detached state: ${performanceNow()} `);

        return Container.create(
            this.codeLoader,
            source,
            this.documentServiceFactory,
            this.resolver,
        );
    }

    public async resolve(request: IRequest): Promise<Container> {
        const resolved = await this.resolveCore(request);
        return resolved.container;
    }

    public async request(request: IRequest): Promise<IResponse> {
        const resolved = await this.resolveCore(request);
        return resolved.container.request({ url: resolved.parsed.path });
    }

    public async requestWorker(baseUrl: string, request: IRequest): Promise<IResponse> {
        // Currently the loader only supports web worker environment. Eventually we will
        // detect environment and bring appropriate loader (e.g., worker_thread for node).
        const supportedEnvironment = "webworker";
        const proxyLoaderFactory = this.proxyLoaderFactories.get(supportedEnvironment);

        // If the loader does not support any other environment, request falls back to current loader.
        if (proxyLoaderFactory === undefined) {
            const container = await this.resolve({ url: baseUrl, headers: request.headers });
            return container.request(request);
        } else {
            const resolved = await this.resolver.resolve({ url: baseUrl, headers: request.headers });
            const resolvedAsFluid = resolved as IFluidResolvedUrl;
            const parsed = parseUrl(resolvedAsFluid.url);
            if (parsed === undefined) {
                return Promise.reject(`Invalid URL ${resolvedAsFluid.url}`);
            }
            const { fromSequenceNumber } =
                this.parseHeader(parsed, { url: baseUrl, headers: request.headers });
            const proxyLoader = await proxyLoaderFactory.createProxyLoader(
                parsed.id,
                resolvedAsFluid,
                fromSequenceNumber,
            );
            return proxyLoader.request(request);
        }
    }

    private async resolveCore(
        request: IRequest,
    ): Promise<{ container: Container; parsed: IParsedUrl }> {
        const resolvedAsFluid = await this.resolver.resolve(request);
        ensureFluidResolvedUrl(resolvedAsFluid);

        // Parse URL into data stores
        const parsed = parseUrl(resolvedAsFluid.url);
        if (parsed === undefined) {
            return Promise.reject(`Invalid URL ${resolvedAsFluid.url}`);
        }
        // parseUrl returns an id of "tenantId/documentId"
        const documentId = parsed.id.split("/")[1];

        request.headers = request.headers ?? {};
        const { canCache, fromSequenceNumber } = this.parseHeader(parsed, request);

        debug(`${canCache} ${request.headers[LoaderHeader.pause]} ${request.headers[LoaderHeader.version]}`);

        let container: Container;
        if (canCache) {
            const versionedId = request.headers[LoaderHeader.version] !== undefined
                ? `${documentId}@${request.headers[LoaderHeader.version]}`
                : documentId;
            const maybeContainer = await this.containers.get(versionedId);
            if (maybeContainer !== undefined) {
                container = maybeContainer;
            } else {
                const containerP =
                    this.loadContainer(
                        documentId,
                        request,
                        resolvedAsFluid);
                this.containers.set(versionedId, containerP);
                container = await containerP;
            }
        } else {
            container =
                await this.loadContainer(
                    documentId,
                    request,
                    resolvedAsFluid);
        }

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

    private parseHeader(parsed: IParsedUrl, request: IRequest) {
        let fromSequenceNumber = -1;

        request.headers = request.headers ?? {};

        const headerSeqNum = request.headers[LoaderHeader.sequenceNumber];
        if (headerSeqNum !== undefined) {
            fromSequenceNumber = headerSeqNum;
        }

        // If set in both query string and headers, use query string
        request.headers[LoaderHeader.version] = parsed.version ?? request.headers[LoaderHeader.version];

        // Version === null means not use any snapshot.
        if (request.headers[LoaderHeader.version] === "null") {
            request.headers[LoaderHeader.version] = null;
        }
        return {
            canCache: this.canUseCache(request),
            fromSequenceNumber,
        };
    }

    private async loadContainer(
        documentId: string,
        request: IRequest,
        resolved: IFluidResolvedUrl,
    ): Promise<Container> {
        return Container.load(
            documentId,
            this.documentServiceFactory,
            this.codeLoader,
            request,
            resolved,
            this.resolver,
        );
    }
}
