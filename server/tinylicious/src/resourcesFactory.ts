/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import fs from "fs";
import { DocumentStorage } from "@fluidframework/server-services-shared";
import {
    IDb,
    IDbFactory,
    MongoDatabaseManager,
    MongoManager,
    IResourcesFactory,
} from "@fluidframework/server-services-core";
import * as git from "isomorphic-git";
import socketIo from "socket.io";

import winston from "winston";
import { TinyliciousResources } from "./resources";
import {
    Historian,
    InMemoryDb,
    LocalOrdererManager,
    PubSubPublisher,
    TinyliciousTenantManager,
    WebServerFactory,
} from "./services";

const defaultTinyliciousPort = 7070;

class DbFactory implements IDbFactory {
    private readonly db = new InMemoryDb();

    public async connect(): Promise<IDb> {
        return this.db;
    }
}

export class TinyliciousResourcesFactory implements IResourcesFactory<TinyliciousResources> {
    public async create(): Promise<TinyliciousResources> {
        // Pull in the default port off the config
        const port = defaultTinyliciousPort;
        // hard coded from config
        const collectionNames = {
            deltas: "deltas",
            documents: "documents",
            nodes: "nodes",
            scribeDeltas: "scribeDeltas",
        };

        const tenantManager = new TinyliciousTenantManager(`http://localhost:${port}`);
        const dbFactory = new DbFactory();
        const mongoManager = new MongoManager(dbFactory);
        const databaseManager = new MongoDatabaseManager(
            mongoManager,
            collectionNames.nodes,
            collectionNames.documents,
            collectionNames.deltas,
            collectionNames.scribeDeltas);
        const storage = new DocumentStorage(databaseManager, tenantManager);
        const io = socketIo();
        const pubsub = new PubSubPublisher(io);
        const webServerFactory = new WebServerFactory(io);

        // Initialize isomorphic-git
        git.plugins.set("fs", fs);

        const orderManager = new LocalOrdererManager(
            storage,
            databaseManager,
            {}, // foreman permissions
            async (tenantId: string) => {
                const url = `http://localhost:${port}/repos/${encodeURIComponent(tenantId)}`;
                return new Historian(url, false, false);
            },
            winston,
            undefined /* serviceConfiguration */,
            pubsub);

        return new TinyliciousResources(
            orderManager,
            tenantManager,
            storage,
            mongoManager,
            port,
            webServerFactory);
    }
}
