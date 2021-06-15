/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import fs from "fs";
import * as git from "isomorphic-git";
import socketIo from "socket.io";

import winston from "winston";
import { TinyliciousResources } from "./resources";
import { TinyliciousRunner } from "./runner";
import {
    IDb,
    IDbFactory,
    MongoDatabaseManager,
    MongoManager,
    IResourcesFactory,
} from "./server-services-core";
import { DocumentStorage } from "./server-services-shared";
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
            async (tenantId: string) => {
                const url = `http://localhost:${port}/repos/${encodeURIComponent(tenantId)}`;
                return new Historian(url);
            },
            winston,
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

/**
 * Uses the provided factories to create and execute a runner.
 */
async function run() {
    const resourceFactory = new TinyliciousResourcesFactory();

    const resources = await resourceFactory.create();

    const runner = new TinyliciousRunner(
        resources.webServerFactory,
        resources.port,
        resources.orderManager,
        resources.tenantManager,
        resources.storage,
        resources.mongoManager,
    );

    // Start the runner and then listen for the message to stop it
    const runningP = runner
        .start()
        .catch(async (error) => {
            await runner
                .stop()
                .catch(() => {
                    error.forceKill = true;
                });
            throw error;
        });

    process.on("SIGTERM", () => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        runner.stop();
    });

    // Wait for the runner to complete
    await runningP;

    // And then dispose of any resources
    await resources.dispose();
}

/**
 * Variant of run that is used to fully run a service. It configures base settings such as logging. And then will
 * exit the service once the runner completes.
 */
export function runTinylicious() {
    run().then(
        () => {
            process.exit(0);
        },
        (error) => {
            if (error.forceKill) {
                process.kill(process.pid, "SIGKILL");
            } else {
                process.exit(1);
            }
        });
}
