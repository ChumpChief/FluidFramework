/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentDeltaConnection,
    IDocumentDeltaStorageService,
    IDocumentService,
    IDocumentStorageService,
} from "@fluidframework/driver-definitions";
import { IClient } from "@fluidframework/protocol-definitions";
import { GitManager, Historian } from "@fluidframework/server-services-client";
import io from "socket.io-client";
import { DeltaStorageService, DocumentDeltaStorageService } from "./deltaStorageService";
import { DocumentStorageService } from "./documentStorageService";
import { R11sDocumentDeltaConnection } from "./documentDeltaConnection";
import { NullBlobStorageService } from "./nullBlobStorageService";
import { ITokenProvider } from "./tokens";

/**
 * The DocumentService manages the Socket.IO connection and manages routing requests to connected
 * clients
 */
export class DocumentService implements IDocumentService {
    constructor(
        private readonly ordererUrl: string,
        private readonly deltaStorageUrl: string,
        private readonly storageUrl: string,
        private readonly tokenProvider: ITokenProvider,
        private readonly tenantId: string,
        private readonly documentId: string,
    ) {
    }

    /**
     * Connects to a storage endpoint for snapshot service.
     *
     * @returns returns the document storage service for routerlicious driver.
     */
    public async connectToStorage(): Promise<IDocumentStorageService> {
        if (this.storageUrl === undefined) {
            return new NullBlobStorageService();
        }

        const storageToken = await this.tokenProvider.fetchStorageToken();
        const credentials = {
            password: storageToken.jwt,
            user: this.tenantId,
        };

        const historian = new Historian(
            this.storageUrl,
            true, // historianApi
            false, // disableCache
            credentials);
        const gitManager = new GitManager(historian);

        return new DocumentStorageService(this.documentId, gitManager);
    }

    /**
     * Connects to a delta storage endpoint for getting ops between a range.
     *
     * @returns returns the document delta storage service for routerlicious driver.
     */
    public async connectToDeltaStorage(): Promise<IDocumentDeltaStorageService> {
        const deltaStorage = new DeltaStorageService(this.deltaStorageUrl, this.tokenProvider);
        return new DocumentDeltaStorageService(this.tenantId, this.documentId, deltaStorage);
    }

    /**
     * Connects to a delta stream endpoint for emitting ops.
     *
     * @returns returns the document delta stream service for routerlicious driver.
     */
    public async connectToDeltaStream(client: IClient): Promise<IDocumentDeltaConnection> {
        const ordererToken = await this.tokenProvider.fetchOrdererToken();
        return R11sDocumentDeltaConnection.create(
            this.tenantId,
            this.documentId,
            ordererToken.jwt,
            io,
            client,
            this.ordererUrl);
    }
}
