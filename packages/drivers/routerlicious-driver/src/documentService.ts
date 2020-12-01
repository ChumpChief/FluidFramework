/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as api from "@fluidframework/driver-definitions";
import { IClient, IErrorTrackingService } from "@fluidframework/protocol-definitions";
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
export class DocumentService implements api.IDocumentService {
    constructor(
        protected ordererUrl: string,
        private readonly deltaStorageUrl: string,
        private readonly gitUrl: string,
        private readonly errorTracking: IErrorTrackingService,
        protected tokenProvider: ITokenProvider,
        protected tenantId: string,
        protected documentId: string,
    ) {
    }

    /**
     * Connects to a storage endpoint for snapshot service.
     *
     * @returns returns the document storage service for routerlicious driver.
     */
    public async connectToStorage(): Promise<api.IDocumentStorageService> {
        if (this.gitUrl === undefined) {
            return new NullBlobStorageService();
        }

        const storageToken = await this.tokenProvider.fetchStorageToken();
        const credentials = {
            password: storageToken.jwt,
            user: this.tenantId,
        };

        const historian = new Historian(
            this.gitUrl,
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
    public async connectToDeltaStorage(): Promise<api.IDocumentDeltaStorageService> {
        const deltaStorage = new DeltaStorageService(this.deltaStorageUrl, this.tokenProvider);
        return new DocumentDeltaStorageService(this.tenantId, this.documentId, deltaStorage);
    }

    /**
     * Connects to a delta stream endpoint for emitting ops.
     *
     * @returns returns the document delta stream service for routerlicious driver.
     */
    public async connectToDeltaStream(client: IClient): Promise<api.IDocumentDeltaConnection> {
        const ordererToken = await this.tokenProvider.fetchOrdererToken();
        return R11sDocumentDeltaConnection.create(
            this.tenantId,
            this.documentId,
            ordererToken.jwt,
            io,
            client,
            this.ordererUrl);
    }

    public getErrorTrackingService() {
        return this.errorTracking;
    }
}
