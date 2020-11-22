/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { Container, Loader } from "@fluidframework/container-loader";
import { IRequest } from "@fluidframework/core-interfaces";
import {
    DriverHeader,
    IDocumentServiceFactory,
    IUrlResolver,
} from "@fluidframework/driver-definitions";
import { ensureFluidResolvedUrl } from "@fluidframework/driver-utils";
import { RouterliciousDocumentServiceFactory } from "@fluidframework/routerlicious-driver";
import { InsecureTinyliciousTokenProvider } from "./insecureTinyliciousTokenProvider";
import { InsecureTinyliciousUrlResolver } from "./insecureTinyliciousUrlResolver";

async function getContainer(
    documentId: string,
    createNew: boolean,
    request: IRequest,
    urlResolver: IUrlResolver,
    documentServiceFactory: IDocumentServiceFactory,
    containerRuntimeFactory: IRuntimeFactory,
): Promise<Container> {
    const loader = new Loader({
        urlResolver,
        documentServiceFactory,
        runtimeFactory: containerRuntimeFactory,
    });

    let container: Container;

    if (createNew) {
        // We're not actually using the code proposal (our code loader always loads the same module regardless of the
        // proposal), but the Container will only give us a NullRuntime if there's no proposal.  So we'll use a fake
        // proposal.
        container = await loader.createDetachedContainer();
        const newRequest = { url: documentId, headers: { [DriverHeader.createNew]: {} } };
        const createNewResolvedUrl = await urlResolver.resolve(newRequest);
        ensureFluidResolvedUrl(createNewResolvedUrl);
        await container.attach(createNewResolvedUrl);
    } else {
        // Request must be appropriate and parseable by resolver.
        container = await loader.resolve(request);
        // If we didn't create the container properly, then it won't function correctly.  So we'll throw if we got a
        // new container here, where we expect this to be loading an existing container.
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        if (!container.existing) {
            throw new Error("Attempted to load a non-existing container");
        }
    }
    return container;
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
): Promise<Container> {
    const tokenProvider = new InsecureTinyliciousTokenProvider(documentId);
    const documentServiceFactory = new RouterliciousDocumentServiceFactory(tokenProvider);

    const urlResolver = new InsecureTinyliciousUrlResolver();

    return getContainer(
        documentId,
        createNew,
        { url: documentId },
        urlResolver,
        documentServiceFactory,
        containerRuntimeFactory,
    );
}
