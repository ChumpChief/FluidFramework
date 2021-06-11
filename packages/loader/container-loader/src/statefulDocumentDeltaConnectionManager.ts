/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentService,
} from "@fluidframework/driver-definitions";
import {
    IClient,
} from "@fluidframework/protocol-definitions";
import { StatefulDocumentDeltaConnection } from "./statefulDocumentDeltaConnection";

export class StatefulDocumentDeltaConnectionManager {
    private readonly defaultClient: IClient = {
        details: {
            capabilities: { interactive: true },
        },
        mode: "write", // default reconnection mode on lost connection / connection error
        permission: [],
        scopes: [],
        user: { id: "" },
    };

    constructor(
        private readonly deltaStreamService: Pick<IDocumentService, "connectToDeltaStream">,
        private readonly statefulDocumentDeltaConnection: StatefulDocumentDeltaConnection,
    ) { }

    public async connect() {
        const connection = await this.deltaStreamService.connectToDeltaStream(this.defaultClient);
        // connection.on("nack")
        // connection.on("disconnect")
        // connection.on("error")
        // connection.on("pong")

        // Drop the new connection into the StatefulDocumentDeltaConnection so the consumer can observe it.
        this.statefulDocumentDeltaConnection.setNewConnection(connection);
    }
}
