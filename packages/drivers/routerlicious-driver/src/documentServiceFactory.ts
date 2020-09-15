/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentService,
    IDocumentServiceFactory,
} from "@fluidframework/driver-definitions";
import { DocumentService } from "./documentService";
import { TokenProvider } from "./tokens";

/**
 * Factory for creating the routerlicious document service. Use this if you want to
 * use the routerlicious implementation.
 */
export class RouterliciousDocumentServiceFactory implements IDocumentServiceFactory {
    public readonly protocolName = "fluid:";

    /**
     * Creates the document service after extracting different endpoints URLs from a resolved URL.
     *
     * @param resolvedUrl - URL containing different endpoint URLs.
     * @returns Routerlicious document service.
     */
    public async createDocumentService(
        storageUrl: string,
        ordererUrl: string,
        deltaStorageUrl: string,
        tenantId: string,
        documentId: string,
        jwtToken: string,
    ): Promise<IDocumentService> {
        const tokenProvider = new TokenProvider(jwtToken);

        return new DocumentService(
            ordererUrl,
            deltaStorageUrl,
            storageUrl,
            tokenProvider,
            tenantId,
            documentId,
        );
    }
}
