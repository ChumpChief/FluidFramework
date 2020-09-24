/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { Container } from "@fluidframework/container-loader";
import { ITokenClaims } from "@fluidframework/protocol-definitions";
import {
    DocumentDeltaStorageService,
    DocumentDeltaService,
    DocumentStorageService,
} from "@fluidframework/routerlicious-driver";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";

/**
 * Connect to the Tinylicious service and retrieve a Container with the given ID running the given code.
 * @param documentId - The document id to retrieve or create
 * @param containerRuntimeFactory - The container factory to be loaded in the container
 */
export async function getTinyliciousContainer(
    documentId: string,
    containerRuntimeFactory: IRuntimeFactory,
): Promise<Container> {
    const deltaStorageUrl = `http://localhost:3000/deltas/tinylicious/${documentId}`;
    const storageUrl = `http://localhost:3000/repos/tinylicious`;
    const ordererUrl = "http://localhost:3000";

    const tenantId = "tinylicious";

    const claims: ITokenClaims = {
        documentId,
        scopes: ["doc:read", "doc:write", "summary:write"],
        tenantId: "tinylicious",
        user: { id: uuid() },
    };

    const jwtToken = jwt.sign(claims, "12345");

    const deltaService = new DocumentDeltaService(
        ordererUrl,
        jwtToken,
        tenantId,
        documentId,
    );

    const deltaStorageService = new DocumentDeltaStorageService(tenantId, jwtToken, deltaStorageUrl);
    const storageService = new DocumentStorageService(documentId, tenantId, jwtToken, storageUrl);

    const container = await Container.load(
        deltaService,
        deltaStorageService,
        storageService,
        containerRuntimeFactory,
    );

    return container;
}
