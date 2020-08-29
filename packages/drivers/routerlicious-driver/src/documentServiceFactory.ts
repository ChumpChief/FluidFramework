/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { parse } from "url";
import {
    IDocumentService,
    IDocumentServiceFactory,
    IResolvedUrl,
} from "@fluidframework/driver-definitions";
import { ITelemetryBaseLogger } from "@fluidframework/common-definitions";
import { IErrorTrackingService, ISummaryTree } from "@fluidframework/protocol-definitions";
import { ICredentials, IGitCache } from "@fluidframework/server-services-client";
import {
    ensureFluidResolvedUrl,
    getDocAttributesFromProtocolSummary,
    getQuorumValuesFromProtocolSummary,
} from "@fluidframework/driver-utils";
import Axios from "axios";
import { DocumentService } from "./documentService";
import { DefaultErrorTracking } from "./errorTracking";
import { TokenProvider } from "./tokens";

/**
 * Factory for creating the routerlicious document service. Use this if you want to
 * use the routerlicious implementation.
 */
export class RouterliciousDocumentServiceFactory implements IDocumentServiceFactory {
    constructor(
        private readonly errorTracking: IErrorTrackingService = new DefaultErrorTracking(),
        private readonly disableCache: boolean = false,
        private readonly historianApi: boolean = true,
        private readonly gitCache: IGitCache | undefined = undefined,
        private readonly credentials?: ICredentials,
    ) {
    }

    public async submitContainer(
        createNewSummary: ISummaryTree,
        resolvedUrl: IResolvedUrl,
        logger?: ITelemetryBaseLogger,
    ): Promise<void> {
        ensureFluidResolvedUrl(resolvedUrl);
        assert(resolvedUrl.endpoints.ordererUrl);
        const parsedUrl = parse(resolvedUrl.url);
        if (!parsedUrl.pathname) {
            throw new Error("Parsed url should contain tenant and doc Id!!");
        }
        const [, tenantId, documentId] = parsedUrl.pathname.split("/");
        const protocolSummary = createNewSummary.tree[".protocol"] as ISummaryTree;
        const appSummary = createNewSummary.tree[".app"] as ISummaryTree;
        if (!(protocolSummary && appSummary)) {
            throw new Error("Protocol and App Summary required in the full summary");
        }
        const documentAttributes = getDocAttributesFromProtocolSummary(protocolSummary);
        const quorumValues = getQuorumValuesFromProtocolSummary(protocolSummary);
        await Axios.post(
            `${resolvedUrl.endpoints.ordererUrl}/documents/${tenantId}`,
            {
                id: documentId,
                summary: appSummary,
                sequenceNumber: documentAttributes.sequenceNumber,
                values: quorumValues,
            });
    }

    /**
     * Creates the document service after extracting different endpoints URLs from a resolved URL.
     *
     * @param resolvedUrl - URL containing different endpoint URLs.
     * @returns Routerlicious document service.
     */
    public async createDocumentService(
        resolvedUrl: IResolvedUrl,
        logger?: ITelemetryBaseLogger,
    ): Promise<IDocumentService> {
        ensureFluidResolvedUrl(resolvedUrl);

        const fluidResolvedUrl = resolvedUrl;
        const storageUrl = fluidResolvedUrl.endpoints.storageUrl;
        const ordererUrl = fluidResolvedUrl.endpoints.ordererUrl;
        const deltaStorageUrl = fluidResolvedUrl.endpoints.deltaStorageUrl;
        if (!ordererUrl || !deltaStorageUrl) {
            throw new Error(
                `All endpoints urls must be provided. [ordererUrl:${ordererUrl}][deltaStorageUrl:${deltaStorageUrl}]`);
        }

        const parsedUrl = parse(fluidResolvedUrl.url);
        const [, tenantId, documentId] = parsedUrl.pathname!.split("/");
        if (!documentId || !tenantId) {
            throw new Error(
                `Couldn't parse documentId and/or tenantId. [documentId:${documentId}][tenantId:${tenantId}]`);
        }

        const jwtToken = fluidResolvedUrl.tokens.jwt;
        if (!jwtToken) {
            throw new Error(`Token was not provided.`);
        }

        const tokenProvider = new TokenProvider(jwtToken);

        return new DocumentService(
            ordererUrl,
            deltaStorageUrl,
            storageUrl,
            this.errorTracking,
            this.disableCache,
            this.historianApi,
            this.credentials,
            this.gitCache,
            tokenProvider,
            tenantId,
            documentId,
        );
    }
}
