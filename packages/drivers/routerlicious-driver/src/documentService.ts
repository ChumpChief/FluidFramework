/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { DocumentDeltaConnection } from "@fluidframework/driver-base";
import * as api from "@fluidframework/driver-definitions";
import { IClient } from "@fluidframework/protocol-definitions";
import { DocumentDeltaStorageService } from "./deltaStorageService";

/**
 * The DocumentService manages the Socket.IO connection and manages routing requests to connected
 * clients
 */
export class DocumentService implements api.IDocumentService {
    constructor(
        private readonly ordererUrl: string,
        private readonly deltaStorageUrl: string,
        private readonly token: string,
        private readonly tenantId: string,
        private readonly documentId: string,
    ) { }

    /**
     * Connects to a delta storage endpoint for getting ops between a range.
     *
     * @returns returns the document delta storage service for routerlicious driver.
     */
    public async connectToDeltaStorage(): Promise<api.IDocumentDeltaStorageService> {
        return new DocumentDeltaStorageService(this.tenantId, this.token, this.deltaStorageUrl);
    }

    /**
     * Connects to a delta stream endpoint for emitting ops.
     *
     * @returns returns the document delta stream service for routerlicious driver.
     */
    public async connectToDeltaStream(client: IClient): Promise<api.IDocumentDeltaConnection> {
        return DocumentDeltaConnection.create(
            this.tenantId,
            this.documentId,
            this.token,
            client,
            this.ordererUrl);
    }
}
