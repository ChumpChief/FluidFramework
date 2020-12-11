/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { Container } from "@fluidframework/container-loader";
import {
    IDocumentService,
    IDocumentStorageService,
} from "@fluidframework/driver-definitions";
import {
    getDocAttributesFromProtocolSummary,
} from "@fluidframework/driver-utils";
import { ISummaryTree } from "@fluidframework/protocol-definitions";
import {
    DocumentService,
} from "@fluidframework/routerlicious-driver";
import Axios from "axios";
import { InsecureTinyliciousTokenProvider } from "./insecureTinyliciousTokenProvider";

async function uploadNewContainer(
    tenantId: string,
    documentId: string,
    ordererUrl: string,
    createNewSummary: ISummaryTree,
): Promise<void> {
    const protocolSummary = createNewSummary.tree[".protocol"] as ISummaryTree;
    const appSummary = createNewSummary.tree[".app"] as ISummaryTree;
    const documentAttributes = getDocAttributesFromProtocolSummary(protocolSummary);
    await Axios.post(
        `${ordererUrl}/documents/${tenantId}`,
        {
            id: documentId,
            summary: appSummary,
            sequenceNumber: documentAttributes.sequenceNumber,
            values: [], // quorumValues
        });
}

async function getContainer(
    tenantId: string,
    documentId: string,
    createNew: boolean,
    documentService: IDocumentService,
    documentStorageService: IDocumentStorageService,
    containerRuntimeFactory: IRuntimeFactory,
): Promise<Container> {
    const ordererUrl = "http://localhost:3000";

    const container = new Container();

    if (createNew) {
        await container.initializeDetached(containerRuntimeFactory);
        // here would be any initial drafting before submitting the new container
        const createNewSummary = container.generateCreateNewSummary();
        await uploadNewContainer(tenantId, documentId, ordererUrl, createNewSummary);
        await container.attach(documentService, documentStorageService);
        // after this block we can start using the container normally
    } else {
        await container.load(
            containerRuntimeFactory,
            documentService,
            documentStorageService,
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
    const tenantId = "tinylicious";

    const deltaStorageUrl = `http://localhost:3000/deltas/tinylicious/${documentId}`;
    const ordererUrl = "http://localhost:3000";
    const storageUrl = `http://localhost:3000/repos/tinylicious`;

    const documentService = new DocumentService(
        ordererUrl,
        deltaStorageUrl,
        storageUrl,
        tokenProvider,
        tenantId,
        documentId,
    );

    const documentStorageService = await documentService.connectToStorage();

    return getContainer(
        tenantId,
        documentId,
        createNew,
        documentService,
        documentStorageService,
        containerRuntimeFactory,
    );
}
