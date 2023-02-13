/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";
import { configureWebSocketServices } from "@fluidframework/server-lambdas";
import { IPubSub, PubSub } from "@fluidframework/server-memory-orderer";
import { generateToken, IHistorian } from "@fluidframework/server-services-client";
import {
    DefaultMetricClient,
    EmptyTaskMessageSender,
    ICollection,
    IDatabaseManager,
    IDb,
    IDocumentStorage,
    ILogger,
    ISequencedOperationMessage,
    IWebSocketServer,
    MongoDatabaseManager,
    MongoManager,
} from "@fluidframework/server-services-core";
import { Lumberjack, TestEngine1 } from "@fluidframework/server-services-telemetry";
import {
    DebugLogger,
    TestClientManager,
    TestDocumentStorage,
    TestHistorian,
    TestTenantManager,
} from "@fluidframework/server-test-utils";
import { SharedWorkerWebSocketServer } from "./sharedWorkerWebSocketServer";
import { LocalOrdererManager } from "./localOrdererManager";
import { IndexedDbDb } from "./indexedDbDb";
import {
    IDeltaStorageMessageFromServer,
    IHistorianMessageFromServer,
    ISharedWorkerMessageToServer,
    ISharedWorkerPortConnectionMessageToServer,
} from "./messageInterfaces";

/**
 * Items needed for handling deltas.
 */
export interface ISharedWorkerDeltaConnectionServer {
    readonly webSocketServer: IWebSocketServer;
    readonly databaseManager: IDatabaseManager;
    readonly testDatabase: IDb;
    close(): Promise<void>;
    hasPendingWork(): Promise<boolean>;
    connectDeltaStorageService(tenantId: string, documentId: string): Promise<SharedWorkerDeltaStorageConnection>;
}

/**
 * Implementation of local delta connection server.
 */
export class SharedWorkerServer implements ISharedWorkerDeltaConnectionServer {
    public readonly webSocketServer: SharedWorkerWebSocketServer;
    public readonly databaseManager: IDatabaseManager;
    private readonly ordererManager: LocalOrdererManager;
    public readonly testDatabase: IDb;
    private readonly historian: IHistorian;
    public readonly documentStorage: IDocumentStorage;
    private readonly logger: ILogger;

    public constructor() {
        if (!Lumberjack.isSetupCompleted()) {
            Lumberjack.setup([new TestEngine1()]);
        }

        globalThis.addEventListener("connect", this.handlePortConnect);

        this.testDatabase = new IndexedDbDb();

        const nodesCollectionName = "nodes";
        const documentsCollectionName = "documents";
        const deltasCollectionName = "deltas";
        const scribeDeltasCollectionName = "scribeDeltas";

        const pubsub: IPubSub = new PubSub();
        this.webSocketServer = new SharedWorkerWebSocketServer(pubsub);
        const mongoManager = new MongoManager({ connect: async () => this.testDatabase });
        const testTenantManager = new TestTenantManager(undefined, undefined, this.testDatabase);

        this.databaseManager = new MongoDatabaseManager(
            false,
            mongoManager,
            mongoManager,
            nodesCollectionName,
            documentsCollectionName,
            deltasCollectionName,
            scribeDeltasCollectionName,
        );

        this.documentStorage = new TestDocumentStorage(
            this.databaseManager,
            testTenantManager,
        );

        this.logger = DebugLogger.create("fluid-server:LocalDeltaConnectionServer");

        this.historian = new TestHistorian(this.testDatabase);

        this.ordererManager = new LocalOrdererManager(
            this.documentStorage,
            this.databaseManager,
            testTenantManager,
            new EmptyTaskMessageSender(),
            {},
            generateToken,
            async () => this.historian,
            this.logger,
            undefined, // serviceConfiguration
            pubsub,
        );

        configureWebSocketServices(
            this.webSocketServer,
            this.ordererManager,
            testTenantManager,
            this.documentStorage,
            new TestClientManager(),
            new DefaultMetricClient(),
            this.logger,
        );
    }

    private readonly handlePortConnect = (event: Event) => {
        // TS doesn't know that the "connect" event is a MessageEvent, so we have to cast.
        const connectEvent: MessageEvent = event as MessageEvent;
        const port = connectEvent.ports[0];
        const determineTypeP = new Promise<ISharedWorkerPortConnectionMessageToServer>((resolve) => {
            const watchForType = (firstMessageEvent: MessageEvent) => {
                resolve(firstMessageEvent.data);
                port.removeEventListener("message", watchForType);
            };
            port.addEventListener("message", watchForType);
        });
        determineTypeP.then((message) => {
            if (message.type === "REST") {
                this.setUpPortForRest(port, message.tenantId, message.documentId);
            } else if (message.type === "socket") {
                this.setUpPortForSocket(port, message.tenantId, message.documentId);
            } else {
                throw new Error(`Unknown port type requested: ${message.type}`);
            }
        }).catch(console.error);
        port.start();
    };

    private readonly setUpPortForRest = (port: MessagePort, tenantId: string, documentId: string) => {
        port.addEventListener("message", (event: MessageEvent) => {
            const message = event.data as ISharedWorkerMessageToServer;

            if (message.service === "deltaStorage" && message.payload.type === "getDeltas") {
                const deltaCollectionP = this.databaseManager.getDeltaCollection(tenantId, documentId);
                deltaCollectionP.then(async (deltaCollection) => {
                    const query = { documentId, tenantId };
                    query["operation.sequenceNumber"] = {};
                    query["operation.sequenceNumber"].$gt = message.payload.from - 1; // from is inclusive
                    query["operation.sequenceNumber"].$lt = message.payload.to;

                    const dbDeltas = await deltaCollection.find(query, { "operation.sequenceNumber": 1 });
                    const messages = dbDeltas.map((delta) => delta.operation);
                    const responseMessage: IDeltaStorageMessageFromServer = {
                        service: "deltaStorage",
                        requestId: message.requestId,
                        payload: {
                            type: "getDeltas",
                            data: messages,
                        },
                    };
                    port.postMessage(responseMessage);
                }).catch(console.error);
            } else if (message.service === "historian") {
                let responseDataP: Promise<any>;
                switch (message.payload.type) {
                    case "getHeader": {
                        responseDataP = this.historian.getHeader(message.payload.sha);
                        break;
                    }
                    case "getBlob": {
                        responseDataP = this.historian.getBlob(message.payload.sha);
                        break;
                    }
                    case "createBlob": {
                        responseDataP = this.historian.createBlob(message.payload.blob);
                        break;
                    }
                    case "getContent": {
                        responseDataP = this.historian.getContent(message.payload.path, message.payload.ref);
                        break;
                    }
                    case "getCommits": {
                        responseDataP = this.historian.getCommits(message.payload.sha, message.payload.count);
                        break;
                    }
                    case "getCommit": {
                        responseDataP = this.historian.getCommit(message.payload.sha);
                        break;
                    }
                    case "createCommit": {
                        responseDataP = this.historian.createCommit(message.payload.commit);
                        break;
                    }
                    case "getRef": {
                        responseDataP = this.historian.getRef(message.payload.ref);
                        break;
                    }
                    case "createRef": {
                        responseDataP = this.historian.createRef(message.payload.params);
                        break;
                    }
                    case "updateRef": {
                        responseDataP = this.historian.updateRef(message.payload.ref, message.payload.params);
                        break;
                    }
                    case "createTree": {
                        responseDataP = this.historian.createTree(message.payload.tree);
                        break;
                    }
                    case "getTree": {
                        responseDataP = this.historian.getTree(message.payload.sha, message.payload.recursive);
                        break;
                    }
                    default: {
                        throw new Error(`Unknown historian message type: ${(message.payload as any).type}`);
                    }
                }
                responseDataP.then((responseData) => {
                    const responseMessage: IHistorianMessageFromServer = {
                        service: "historian",
                        requestId: message.requestId,
                        payload: {
                            type: message.payload.type,
                            data: responseData,
                        },
                    };
                    port.postMessage(responseMessage);
                }).catch(console.error);
            } else {
                throw new Error(`Unexpected service requested: ${message.service}`);
            }
        });
    };

    private readonly setUpPortForSocket = (port: MessagePort, tenantId: string, documentId: string) => {
        this.webSocketServer.addConnection(port);
    };

    public async close() {
        await this.webSocketServer.close();
        await this.ordererManager.close();
    }

    /**
     * Returns true if there are any received ops that are not yet ordered.
     */
    public async hasPendingWork(): Promise<boolean> {
        return this.ordererManager.hasPendingWork();
    }

    public async connectDeltaStorageService(tenantId: string, documentId: string) {
        const deltaCollection = await this.databaseManager.getDeltaCollection(tenantId, documentId);
        return new SharedWorkerDeltaStorageConnection(
            tenantId,
            documentId,
            deltaCollection,
        );
    }
}

export class SharedWorkerDeltaStorageConnection {
    public constructor(
        private readonly tenantId: string,
        private readonly documentId: string,
        private readonly deltaCollection: ICollection<ISequencedOperationMessage>,
    ) { }

    public async fetchMessages(from: number, to?: number): Promise<ISequencedDocumentMessage[]> {
        const query = { documentId: this.documentId, tenantId: this.tenantId };
        query["operation.sequenceNumber"] = {};
        query["operation.sequenceNumber"].$gt = from - 1; // from is inclusive
        query["operation.sequenceNumber"].$lt = to;

        const dbDeltas = await this.deltaCollection.find(query, { "operation.sequenceNumber": 1 });
        const messages = dbDeltas.map((delta) => delta.operation);
        return messages;
    }
}
