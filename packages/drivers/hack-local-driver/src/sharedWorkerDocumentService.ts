/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { TelemetryNullLogger } from "@fluidframework/common-utils";
import {
    IDocumentDeltaConnection,
    IDocumentDeltaStorageService,
    IDocumentService,
    IDocumentStorageService,
    IResolvedUrl,
} from "@fluidframework/driver-definitions";
import { IClient } from "@fluidframework/protocol-definitions";
import { DocumentStorageService, ITokenProvider } from "@fluidframework/routerlicious-driver";
import { ISharedWorkerPortConnectionMessageToServer } from "@fluidframework/server-hack-local-server";
import { GitManager } from "@fluidframework/server-services-client";

import { SharedWorkerDeltaStorageService } from "./sharedWorkerDeltaStorageService";
import { SharedWorkerDocumentDeltaConnection } from "./sharedWorkerDocumentDeltaConnection";
import { SharedWorkerHistorian } from "./sharedWorkerHistorian";

// TODO: any neat tricks to try for bundling strategies?  import.meta.url doesn't work for commonjs
const workerURL = new URL("./sharedWorkerServer.bundle.js", import.meta.url);

export class SharedWorkerDocumentService implements IDocumentService {
    private readonly restPort: MessagePort;

    public constructor(
        private readonly tenantId: string,
        private readonly documentId: string,
        public readonly resolvedUrl: IResolvedUrl,
        private readonly tokenProvider: ITokenProvider,
    ) {
        // Connect REST port to SharedWorker -- we'll set up the websocket port separately.
        const worker = new SharedWorker(workerURL);
        this.restPort = worker.port;
        this.restPort.start();
        const portConnectionMessage: ISharedWorkerPortConnectionMessageToServer = {
            type: "REST",
            tenantId,
            documentId,
        };
        this.restPort.postMessage(portConnectionMessage);
    }

    public async connectToStorage(): Promise<IDocumentStorageService> {
        // TODO: Consider writing a separate DocumentStorageService specific for this usage?
        return new DocumentStorageService(
            this.documentId,
            new GitManager(new SharedWorkerHistorian(this.restPort)),
            new TelemetryNullLogger(),
            { minBlobSize: 2048 }, // Test blob aggregation.
            undefined,
            undefined,
            undefined,
            new GitManager(new SharedWorkerHistorian(this.restPort)),
        );
    }

    public async connectToDeltaStorage(): Promise<IDocumentDeltaStorageService> {
        return new SharedWorkerDeltaStorageService(this.restPort);
    }

    public async connectToDeltaStream(client: IClient): Promise<IDocumentDeltaConnection> {
        const ordererToken = await this.tokenProvider.fetchOrdererToken(
            this.tenantId,
            this.documentId,
        );

        const worker = new SharedWorker(workerURL);
        const socketPort = worker.port;
        socketPort.start();
        const portConnectionMessage: ISharedWorkerPortConnectionMessageToServer = {
            type: "socket",
            tenantId: this.tenantId,
            documentId: this.documentId,
        };
        socketPort.postMessage(portConnectionMessage);

        const documentDeltaConnection = await SharedWorkerDocumentDeltaConnection.create(
            this.tenantId,
            this.documentId,
            ordererToken.jwt,
            client,
            socketPort,
        );

        return documentDeltaConnection;
    }

    public async dispose(error?: any) {
        throw new Error("Method not implemented.");
    }
}
