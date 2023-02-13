/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    ICommittedProposal,
    ISummaryTree,
} from "@fluidframework/protocol-definitions";
import {
    MongoDatabaseManager,
    MongoManager,
} from "@fluidframework/server-services-core";
import {
    TestDocumentStorage,
    TestTenantManager,
} from "@fluidframework/server-test-utils";
import { IndexedDbDb } from "./indexedDbDb";

export const indexedDbCreateContainer = async (
    tenantId: string,
    documentId: string,
    summary: ISummaryTree,
    sequenceNumber: number,
    term: number,
    initialHash: string,
    ordererUrl: string,
    historianUrl: string,
    deltaStreamUrl: string,
    values: [string, ICommittedProposal][],
    enableDiscovery?: boolean,
) => {
    const db = new IndexedDbDb();

    const nodesCollectionName = "nodes";
    const documentsCollectionName = "documents";
    const deltasCollectionName = "deltas";
    const scribeDeltasCollectionName = "scribeDeltas";

    const mongoManager = new MongoManager({ connect: async () => db });
    const testTenantManager = new TestTenantManager(undefined, undefined, db);

    const databaseManager = new MongoDatabaseManager(
        false,
        mongoManager,
        mongoManager,
        nodesCollectionName,
        documentsCollectionName,
        deltasCollectionName,
        scribeDeltasCollectionName,
    );

    const testStorage = new TestDocumentStorage(
        databaseManager,
        testTenantManager,
    );

    return testStorage.createDocument(
        tenantId,
        documentId,
        summary,
        sequenceNumber,
        term,
        initialHash,
        ordererUrl,
        historianUrl,
        deltaStreamUrl,
        values,
        enableDiscovery,
    );
};
