/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { IDocumentService } from "@fluidframework/driver-definitions";
import { IRequest } from "@fluidframework/core-interfaces";
import { DebugLogger } from "@fluidframework/telemetry-utils";
import { ISummaryTree, SummaryType } from "@fluidframework/protocol-definitions";
import { OdspDriverUrlResolver } from "../odspDriverUrlResolver";
import { OdspDocumentServiceFactory } from "../odspDocumentServiceFactory";
import { IOdspResolvedUrl } from "../contracts";

describe("Odsp Create Container Test", () => {
    const siteUrl = "https://www.localhost.xxx";
    const driveId = "driveId";
    const filePath = "path";
    const fileName = "fileName";
    let resolver: OdspDriverUrlResolver;
    let request: IRequest;

    const odspDocumentServiceFactory = new OdspDocumentServiceFactory(
        async (url: string, refresh: boolean) => "token",
        async (refresh: boolean) => "token");

    const createSummary = (putAppTree: boolean, putProtocolTree: boolean, sequenceNumber: number) => {
        const summary: ISummaryTree = {
            type: SummaryType.Tree,
            tree: {},
        };
        if (putAppTree) {
            summary.tree[".app"] = {
                type: SummaryType.Tree,
                tree: {},
            };
        }
        if (putProtocolTree) {
            summary.tree[".protocol"] = {
                type: SummaryType.Tree,
                tree: {
                    attributes: {
                        type: SummaryType.Blob,
                        content: JSON.stringify({ branch: "", minimumSequenceNumber: 0, sequenceNumber }),
                    },
                },
            };
        }
        return summary;
    };

    const createService = async (
        summary: ISummaryTree,
        resolved: IOdspResolvedUrl,
    ): Promise<IDocumentService> => odspDocumentServiceFactory.createContainer(
        summary,
        resolved,
        DebugLogger.create("fluid:createContainer"));

    beforeEach(() => {
        resolver = new OdspDriverUrlResolver();
        request = resolver.createCreateNewRequest(siteUrl, driveId, filePath, fileName);
    });

    it("No App Summary", async () => {
        const resolved = await resolver.resolve(request);
        const summary = createSummary(false, true, 0);
        await assert.rejects(createService(summary, resolved),
            "Doc service should not be created because there was no app summary");
    });

    it("Wrong Seq No in Protocol Summary", async () => {
        const resolved = await resolver.resolve(request);
        const summary = createSummary(true, true, 1);
        await assert.rejects(createService(summary, resolved),
            "Doc service should not be created because seq no was wrong");
    });

    it("No item id in response from server", async () => {
        const resolved = await resolver.resolve(request);
        const summary = createSummary(true, true, 0);

        await assert.rejects(createService(summary, resolved),
            "Doc service should not be created because no Item id is there");
    });
});
