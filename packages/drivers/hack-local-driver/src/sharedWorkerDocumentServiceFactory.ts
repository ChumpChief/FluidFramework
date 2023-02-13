/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { parse } from "url";
import {
    IDocumentService,
    IDocumentServiceFactory,
    IResolvedUrl,
} from "@fluidframework/driver-definitions";
import { DefaultTokenProvider } from "@fluidframework/routerlicious-driver";
import { indexedDbCreateContainer } from "@fluidframework/server-hack-local-server";
import {
    ensureFluidResolvedUrl,
    getDocAttributesFromProtocolSummary,
    getQuorumValuesFromProtocolSummary,
} from "@fluidframework/driver-utils";
import { ISummaryTree } from "@fluidframework/protocol-definitions";
import { defaultHash } from "@fluidframework/server-services-client";
import { SharedWorkerDocumentService } from "./sharedWorkerDocumentService";

export class SharedWorkerDocumentServiceFactory implements IDocumentServiceFactory {
    public get protocolName(): string {
        throw new Error("This is not a protocol, don't use it.");
    }

    public async createContainer(
        createNewSummary: ISummaryTree | undefined,
        resolvedUrl: IResolvedUrl,
    ): Promise<IDocumentService> {
        ensureFluidResolvedUrl(resolvedUrl);
        if (createNewSummary === undefined) {
            throw new Error("Empty file summary creation isn't supported in this driver.");
        }
        const pathName = new URL(resolvedUrl.url).pathname;
        const pathArr = pathName.split("/");
        const tenantId = pathArr[pathArr.length - 2];
        const id = pathArr[pathArr.length - 1];

        const protocolSummary = createNewSummary.tree[".protocol"] as ISummaryTree;
        const appSummary = createNewSummary.tree[".app"] as ISummaryTree;
        if (!(protocolSummary && appSummary)) {
            throw new Error("Protocol and App Summary required in the full summary");
        }
        const documentAttributes = getDocAttributesFromProtocolSummary(protocolSummary);
        const quorumValues = getQuorumValuesFromProtocolSummary(protocolSummary);
        const sequenceNumber = documentAttributes.sequenceNumber;

        // This will actually create the container from the tab, not from the SharedWorker.  But it doesn't really
        // matter, since both have equal access to the db.
        await indexedDbCreateContainer(
            tenantId,
            id,
            appSummary,
            sequenceNumber,
            documentAttributes.term ?? 1,
            defaultHash,
            resolvedUrl.endpoints.ordererUrl ?? "",
            resolvedUrl.endpoints.storageUrl ?? "",
            resolvedUrl.endpoints.deltaStreamUrl ?? resolvedUrl.endpoints.ordererUrl ?? "",
            quorumValues,
            false, /* enableDiscovery */
        );

        return this.createDocumentService(resolvedUrl);
    }

    public async createDocumentService(
        resolvedUrl: IResolvedUrl,
    ): Promise<IDocumentService> {
        ensureFluidResolvedUrl(resolvedUrl);

        const parsedUrl = parse(resolvedUrl.url);
        const [, tenantId, documentId] = parsedUrl.path ? parsedUrl.path.split("/") : [];
        if (!documentId || !tenantId) {
            throw new Error(`Couldn't parse resolved url. [documentId:${documentId}][tenantId:${tenantId}]`);
        }

        const fluidResolvedUrl = resolvedUrl;
        const jwtToken = fluidResolvedUrl.tokens.jwt;
        if (!jwtToken) {
            throw new Error(`Token was not provided.`);
        }

        const tokenProvider = new DefaultTokenProvider(jwtToken);

        return new SharedWorkerDocumentService(
            tenantId,
            documentId,
            resolvedUrl,
            tokenProvider,
        );
    }
}
