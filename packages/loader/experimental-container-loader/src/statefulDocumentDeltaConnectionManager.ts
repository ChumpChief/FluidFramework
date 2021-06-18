/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

// eslint-disable-next-line import/no-internal-modules
import merge from "lodash/merge";
import {
    IDocumentDeltaConnection,
    IDocumentService,
} from "@fluidframework/driver-definitions";
import {
    IClient,
    IClientDetails,
} from "@fluidframework/protocol-definitions";
import { StatefulDocumentDeltaConnection } from "./statefulDocumentDeltaConnection";

export class StatefulDocumentDeltaConnectionManager {
    // currentClient's properties may be modified over time
    private readonly currentClient: IClient = {
        details: {
            capabilities: { interactive: true },
        },
        mode: "read",
        permission: [],
        scopes: [],
        user: { id: "" },
    };

    private connectionP: Promise<IDocumentDeltaConnection> | undefined;
    private currentConnection: IDocumentDeltaConnection | undefined;

    private autoReconnectEnabled: boolean = true;

    constructor(
        private readonly deltaStreamService: Pick<IDocumentService, "connectToDeltaStream">,
        private readonly statefulDocumentDeltaConnection: StatefulDocumentDeltaConnection,
        clientDetailsOverride: IClientDetails | undefined,
    ) {
        merge(this.currentClient.details, clientDetailsOverride);
    }

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

        this.connectionP = this.deltaStreamService.connectToDeltaStream(this.currentClient);
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

    public async setReadonlyMode(enable: boolean): Promise<void> {
        // Arbitrary policy -- we will reconnect if you were connected before, or stay disconnected if you weren't
        let previouslyConnected = false;
        if (
            this.statefulDocumentDeltaConnection.connected
            // Since Tinylicious lies about doc:write scope, we can't reliably know whether we have write permissions
            /* && this.statefulDocumentDeltaConnection.readonlyScope */
        ) {
            previouslyConnected = true;
            this.disconnect();
        }

        this.currentClient.mode = enable
            ? "read"
            : "write";

        // TODO this is a little strange that sometimes you'll still be connected after setting readonly mode
        // and sometimes you won't
        if (previouslyConnected && this.autoReconnectEnabled) {
            await this.connect();
        }
    }

    public setAutoReconnectMode(enable: boolean) {
        this.autoReconnectEnabled = enable;
    }

    private readonly nackHandler = () => {
        // Nack probably means we tried to send an op in read mode.
        // Arbitrary policy is to disconnect and then reconnect in write mode.
        // TODO Check if a reconnect attempt is allowed
        // TODO Follow reconnect policy (delay, inspect error, etc.)
        this.setReadonlyMode(false).catch(console.error);
    };

    private readonly disconnectHandler = () => {
        this.disconnect();
        // TODO Check if a reconnect attempt is allowed
        // TODO Follow reconnect policy (delay, inspect reason, etc.)
        if (this.autoReconnectEnabled) {
            this.connect().catch(console.error);
        }
    };

    private readonly errorHandler = () => {
        this.disconnect();
        // TODO Check if a reconnect attempt is allowed
        // TODO Follow reconnect policy (delay, inspect error, etc.)
        if (this.autoReconnectEnabled) {
            this.connect().catch(console.error);
        }
    };

    private readonly pongHandler = () => {
    };
}
