/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentService,
    IDocumentServiceFactory,
} from "@fluidframework/driver-definitions";
import { IErrorTrackingService, ISummaryTree } from "@fluidframework/protocol-definitions";
import { ICredentials, IGitCache } from "@fluidframework/server-services-client";
import {
    getDocAttributesFromProtocolSummary,
    getQuorumValuesFromProtocolSummary,
} from "@fluidframework/driver-utils";
import Axios from "axios";
import { DocumentService } from "./documentService";
import { DefaultErrorTracking } from "./errorTracking";
import { ITokenProvider } from "./tokens";

/**
 * Factory for creating the routerlicious document service. Use this if you want to
 * use the routerlicious implementation.
 */
export class RouterliciousDocumentServiceFactory implements IDocumentServiceFactory {
    public readonly protocolName = "fluid:";
    constructor(
        private readonly tokenProvider: ITokenProvider,
        private readonly errorTracking: IErrorTrackingService = new DefaultErrorTracking(),
        private readonly disableCache: boolean = false,
        private readonly historianApi: boolean = true,
        private readonly gitCache: IGitCache | undefined = undefined,
        private readonly credentials?: ICredentials,
    ) {
    }

    public async createContainer(
        tenantId: string,
        documentId: string,
        storageUrl: string,
        ordererUrl: string,
        deltaStorageUrl: string,
        createNewSummary: ISummaryTree,
    ): Promise<IDocumentService> {
        const protocolSummary = createNewSummary.tree[".protocol"] as ISummaryTree;
        const appSummary = createNewSummary.tree[".app"] as ISummaryTree;
        if (!(protocolSummary && appSummary)) {
            throw new Error("Protocol and App Summary required in the full summary");
        }
        const documentAttributes = getDocAttributesFromProtocolSummary(protocolSummary);
        const quorumValues = getQuorumValuesFromProtocolSummary(protocolSummary);
        await Axios.post(
            `${ordererUrl}/documents/${tenantId}`,
            {
                id: documentId,
                summary: appSummary,
                sequenceNumber: documentAttributes.sequenceNumber,
                values: quorumValues,
            });
        return this.createDocumentService(
            storageUrl,
            ordererUrl,
            deltaStorageUrl,
            tenantId,
            documentId,
        );
    }

    /**
     * Creates the document service after extracting different endpoints URLs from a resolved URL.
     *
     * @param fluidResolvedUrl - URL containing different endpoint URLs.
     * @returns Routerlicious document service.
     */
    public async createDocumentService(
        storageUrl: string,
        ordererUrl: string,
        deltaStorageUrl: string,
        tenantId: string,
        documentId: string,
    ): Promise<IDocumentService> {
        if (!ordererUrl || !deltaStorageUrl) {
            throw new Error(
                `All endpoints urls must be provided. [ordererUrl:${ordererUrl}][deltaStorageUrl:${deltaStorageUrl}]`);
        }

        return new DocumentService(
            ordererUrl,
            deltaStorageUrl,
            storageUrl,
            this.errorTracking,
            this.disableCache,
            this.historianApi,
            this.credentials,
            this.gitCache,
            this.tokenProvider,
            tenantId,
            documentId,
        );
    }
}
