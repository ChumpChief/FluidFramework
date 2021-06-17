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
        // TODO make this read by default
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
        if (this.currentConnection !== undefined) {
            return;
        }

        if (this.connectionP !== undefined) {
            // TODO If this eventually takes connection args, consider throwing (esp. if the args don't match)?
            // Or just having a less-explicit connect method.
            await this.connectionP;
            return;
        }

        this.connectionP = this.deltaStreamService.connectToDeltaStream(this.defaultClient);
        this.currentConnection = await this.connectionP;
        this.connectionP = undefined;

        this.currentConnection.on("nack", this.nackHandler);
        this.currentConnection.on("disconnect", this.disconnectHandler);
        this.currentConnection.on("error", this.errorHandler);
        this.currentConnection.on("pong", this.pongHandler);

        // Drop the new connection into the StatefulDocumentDeltaConnection so the consumer can observe it.
        this.statefulDocumentDeltaConnection.setNewConnection(this.currentConnection);
    }

    public disconnect() {
        if (this.currentConnection === undefined) {
            throw new Error("Tried to disconnect, but not currently connected");
        }

        // TODO abort any in-progress connection

        this.currentConnection.off("nack", this.nackHandler);
        this.currentConnection.off("disconnect", this.disconnectHandler);
        this.currentConnection.off("error", this.errorHandler);
        this.currentConnection.off("pong", this.pongHandler);

        this.statefulDocumentDeltaConnection.tearDownCurrentConnection();
        const connection = this.currentConnection;
        this.currentConnection = undefined;
        connection.close();
    }

    private readonly nackHandler = () => {
        this.disconnect();
        // TODO When read mode is default, need to reconnect in write mode here.
        // TODO Check if a reconnect attempt is allowed
        // TODO Follow reconnect policy (delay, etc.)
        this.connect().catch(console.error);
    };

    private readonly disconnectHandler = () => {
        this.disconnect();
        // TODO Check if a reconnect attempt is allowed
        // TODO Follow reconnect policy (delay, etc.)
        this.connect().catch(console.error);
    };

    private readonly errorHandler = () => {
        this.disconnect();
        // TODO Check if a reconnect attempt is allowed
        // TODO Follow reconnect policy (delay, etc.)
        this.connect().catch(console.error);
    };

    private readonly pongHandler = () => {
    };
}
