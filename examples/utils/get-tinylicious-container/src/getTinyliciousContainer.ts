/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { Container } from "@fluidframework/container-loader";
import {
    DriverHeader,
    IDocumentServiceFactory,
    IUrlResolver,
} from "@fluidframework/driver-definitions";
import { RouterliciousDocumentServiceFactory } from "@fluidframework/routerlicious-driver";
import { InsecureTinyliciousTokenProvider } from "./insecureTinyliciousTokenProvider";
import { InsecureTinyliciousUrlResolver } from "./insecureTinyliciousUrlResolver";

async function getContainer(
    tenantId: string,
    documentId: string,
    createNew: boolean,
    urlResolver: IUrlResolver,
    documentServiceFactory: IDocumentServiceFactory,
    containerRuntimeFactory: IRuntimeFactory,
): Promise<Container> {
    const deltaStorageUrl = `http://localhost:3000/deltas/tinylicious/${documentId}`;
    const ordererUrl = "http://localhost:3000";
    const storageUrl = `http://localhost:3000/repos/tinylicious`;

    let container: Container;

    if (createNew) {
        // We're not actually using the code proposal (our code loader always loads the same module regardless of the
        // proposal), but the Container will only give us a NullRuntime if there's no proposal.  So we'll use a fake
        // proposal.
        container = new Container(
            containerRuntimeFactory,
            documentServiceFactory,
            {}, // options
            true, // canReconnect
            undefined, // documentId
            undefined, // originalRequest
        );
        await container.initializeDetached();
        const newRequest = { url: documentId, headers: { [DriverHeader.createNew]: {} } };
        const createNewResolvedUrl = await urlResolver.resolve(newRequest);
        if (createNewResolvedUrl === undefined) {
            throw new Error("Could not resolve");
        }
        await container.attach(createNewResolvedUrl, tenantId, documentId);
    } else {
        container = await Container.load(
            tenantId,
            documentId,
            containerRuntimeFactory,
            documentServiceFactory,
            {}, // options
            true, // canReconnect
            storageUrl,
            ordererUrl,
            deltaStorageUrl,
        );
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
        "tinylicious", // tenantId
        documentId,
        createNew,
        urlResolver,
        documentServiceFactory,
        containerRuntimeFactory,
    );
}
