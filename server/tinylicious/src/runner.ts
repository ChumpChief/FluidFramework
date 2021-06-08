/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import * as winston from "winston";
import detect from "detect-port";
import { createExpressApp } from "./app";
import { Deferred } from "./common-utils";
import { configureWebSocketServices } from "./lambdas";
import {
    IDocumentStorage,
    IOrdererManager,
    ITenantManager,
    IWebServer,
    IWebServerFactory,
    MongoManager,
    DefaultMetricClient,
    IRunner,
} from "./server-services-core";
import { TestClientManager } from "./server-test-utils";

export class TinyliciousRunner implements IRunner {
    private server: IWebServer;
    private runningDeferred: Deferred<void>;

    constructor(
        private readonly serverFactory: IWebServerFactory,
        private readonly port: number,
        private readonly orderManager: IOrdererManager,
        private readonly tenantManager: ITenantManager,
        private readonly storage: IDocumentStorage,
        private readonly mongoManager: MongoManager,
    ) { }

    public async start(): Promise<void> {
        this.runningDeferred = new Deferred<void>();

        // Make sure provided port is unoccupied
        await this.ensurePortIsFree();

        const expressApp = createExpressApp(this.storage, this.mongoManager);
        expressApp.set("port", this.port);

        this.server = this.serverFactory.create(expressApp);
        const httpServer = this.server.httpServer;

        configureWebSocketServices(
            this.server.webSocketServer,
            this.orderManager,
            this.tenantManager,
            this.storage,
            new TestClientManager(),
            new DefaultMetricClient(),
            winston,
        );

        // Listen on provided port, on all network interfaces.
        httpServer.listen(this.port);
        httpServer.on("error", (error) => this.onError(error));

        return this.runningDeferred.promise;
    }

    public stop(): Promise<void> {
        // Close the underlying server and then resolve the runner once closed
        this.server.close().then(
            () => {
                this.runningDeferred.resolve();
            },
            (error) => {
                this.runningDeferred.reject(error);
            },
        );

        return this.runningDeferred.promise;
    }

    /**
     * Ensure provided port is free
     */
    private async ensurePortIsFree(): Promise<void> {
        const freePort = await detect(this.port);
        if (this.port !== freePort) {
            throw new Error(`Port: ${this.port} is occupied. Try port: ${freePort}`);
        }
    }

    /**
     * Event listener for HTTP server "error" event.
     */
    private onError(error) {
        if (error.syscall !== "listen") {
            throw error;
        }

        const bind =
            typeof this.port === "string"
                ? `Pipe ${this.port}`
                : `Port ${this.port}`;

        // Handle specific listen errors with friendly messages
        switch (error.code) {
            case "EACCES":
                this.runningDeferred.reject(
                    `${bind} requires elevated privileges`,
                );
                break;
            case "EADDRINUSE":
                this.runningDeferred.reject(`${bind} is already in use`);
                break;
            default:
                throw error;
        }
    }
}
