/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentDeltaConnection,
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

    private connectionP: Promise<IDocumentDeltaConnection> | undefined;
    private currentConnection: IDocumentDeltaConnection | undefined;

    constructor(
        private readonly deltaStreamService: Pick<IDocumentService, "connectToDeltaStream">,
        private readonly statefulDocumentDeltaConnection: StatefulDocumentDeltaConnection,
    ) { }

    public async connect(): Promise<void> {
        // TODO do I need an event indicating that it's starting to connect?  The deltaManager wants to request
        // ops from storage at the start of connection.

        if (this.connectionP !== undefined) {
            // TODO If this eventually takes connection args, consider throwing (esp. if the args don't match)?
            // Or just having a less-explicit connect method.
            await this.connectionP;
            return;
        }

        this.connectionP = this.deltaStreamService.connectToDeltaStream(this.defaultClient);
        const connection = await this.connectionP;
        // connection.on("nack")
        // connection.on("disconnect")
        // connection.on("error")
        // connection.on("pong")

        // Drop the new connection into the StatefulDocumentDeltaConnection so the consumer can observe it.
        this.statefulDocumentDeltaConnection.setNewConnection(connection);
    }

    public async disconnect() {
        if (this.currentConnection === undefined) {
            throw new Error("Tried to disconnect, but not currently connected");
        }

        // TODO abort any in-progress connection

        this.statefulDocumentDeltaConnection.tearDownCurrentConnection();
        const connection = this.currentConnection;
        this.currentConnection = undefined;
        connection.close();
    }
}
