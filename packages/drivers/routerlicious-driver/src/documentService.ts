/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { DocumentDeltaConnection } from "@fluidframework/driver-base";
import * as api from "@fluidframework/driver-definitions";
import { IClient } from "@fluidframework/protocol-definitions";

/**
 * The DocumentService manages the Socket.IO connection and manages routing requests to connected
 * clients
 */
export class DocumentDeltaService implements api.IDocumentDeltaService {
    constructor(
        private readonly ordererUrl: string,
        private readonly token: string,
        private readonly tenantId: string,
        private readonly documentId: string,
    ) { }

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
