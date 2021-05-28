/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IContainer,
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { Container, Loader } from "@fluidframework/container-loader";
import { IDocumentServiceFactory, IUrlResolver } from "@fluidframework/driver-definitions";
import { RouterliciousDocumentServiceFactory } from "@fluidframework/routerlicious-driver";
import { InsecureTinyliciousTokenProvider, InsecureTinyliciousUrlResolver } from "@fluidframework/tinylicious-driver";

export interface IGetContainerService {
    documentServiceFactory: IDocumentServiceFactory;
    urlResolver: IUrlResolver;
}

export async function getContainer(
    getContainerService: IGetContainerService,
    containerId: string,
    containerRuntimeFactory: IRuntimeFactory,
    createNew: boolean,
): Promise<Container> {
    const module = { fluidExport: containerRuntimeFactory };
    const codeLoader = { load: async () => module };

    const loader = new Loader({
        urlResolver: getContainerService.urlResolver,
        documentServiceFactory: getContainerService.documentServiceFactory,
        codeLoader,
    });

    let container: Container;

    if (createNew) {
        // We're not actually using the code proposal (our code loader always loads the same module regardless of the
        // proposal), but the Container will only give us a NullRuntime if there's no proposal.  So we'll use a fake
        // proposal.
        container = await loader.createDetachedContainer({ package: "no-dynamic-package", config: {} });
        await container.attach({ url: containerId });
    } else {
        // Request must be appropriate and parseable by resolver.
        container = await loader.resolve({ url: containerId });
        // If we didn't create the container properly, then it won't function correctly.  So we'll throw if we got a
        // new container here, where we expect this to be loading an existing container.
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        if (!container.existing) {
            throw new Error("Attempted to load a non-existing container");
        }
    }
    return container;
}

export class TinyliciousService implements IGetContainerService {
    public readonly documentServiceFactory: IDocumentServiceFactory;
    public readonly urlResolver: IUrlResolver;

    constructor(tinyliciousPort?: number) {
        const tokenProvider = new InsecureTinyliciousTokenProvider();
        this.urlResolver = new InsecureTinyliciousUrlResolver(tinyliciousPort);
        this.documentServiceFactory = new RouterliciousDocumentServiceFactory(tokenProvider);
    }
}

/**
 * Connect to the Tinylicious service and retrieve a Container with the given ID running the given code.
 * @param documentId - The document id to retrieve or create
 * @param containerRuntimeFactory - The container factory to be loaded in the container
 */
export async function getTinyliciousContainer(
    documentId: string,
    containerRuntimeFactory: IRuntimeFactory,
    createNew: boolean,
    tinyliciousPort?: number,
): Promise<IContainer> {
    const service = new TinyliciousService(tinyliciousPort);

    return getContainer(
        service,
        documentId,
        containerRuntimeFactory,
        createNew,
    );
}
