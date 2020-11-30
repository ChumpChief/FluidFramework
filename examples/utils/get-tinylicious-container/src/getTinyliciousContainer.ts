/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { Container } from "@fluidframework/container-loader";
import {
    IDocumentServiceFactory,
} from "@fluidframework/driver-definitions";
import { RouterliciousDocumentServiceFactory } from "@fluidframework/routerlicious-driver";
import { InsecureTinyliciousTokenProvider } from "./insecureTinyliciousTokenProvider";

async function getContainer(
    tenantId: string,
    documentId: string,
    createNew: boolean,
    documentServiceFactory: IDocumentServiceFactory,
    containerRuntimeFactory: IRuntimeFactory,
): Promise<Container> {
    const deltaStorageUrl = `http://localhost:3000/deltas/tinylicious/${documentId}`;
    const ordererUrl = "http://localhost:3000";
    const storageUrl = `http://localhost:3000/repos/tinylicious`;

    const container = new Container(documentServiceFactory);

    if (createNew) {
        await container.initializeDetached(containerRuntimeFactory);
        await container.attach(
            storageUrl,
            ordererUrl,
            deltaStorageUrl,
            tenantId,
            documentId,
        );
    } else {
        await container.load(
            containerRuntimeFactory,
            tenantId,
            documentId,
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

    return getContainer(
        "tinylicious", // tenantId
        documentId,
        createNew,
        documentServiceFactory,
        containerRuntimeFactory,
    );
}
