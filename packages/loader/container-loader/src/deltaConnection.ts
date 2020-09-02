/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IConnectionDetails,
} from "@fluidframework/container-definitions";
import {
    IDocumentDeltaConnection,
    IDocumentService,
    IDocumentDeltaConnectionEvents,
} from "@fluidframework/driver-definitions";
import {
    IClient,
    IDocumentMessage,
    INack,
} from "@fluidframework/protocol-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";

export class DeltaConnection
    extends TypedEventEmitter<IDocumentDeltaConnectionEvents> {
    public static async connect(
        service: IDocumentService,
        client: IClient) {
        const connection = await service.connectToDeltaStream(client);
        return new DeltaConnection(connection);
    }

    public get details(): IConnectionDetails {
        return this._details;
    }

    public get nacked(): boolean {
        return this._nacked;
    }

    public get connected(): boolean {
        return this._connection !== undefined;
    }

    private readonly _details: IConnectionDetails;
    private _nacked = false;
    private _connection?: IDocumentDeltaConnection;

    private get connection(): IDocumentDeltaConnection {
        if (this._connection === undefined) {
            throw new Error("Connection is closed!");
        }
        return this._connection;
    }

    private constructor(connection: IDocumentDeltaConnection) {
        super();
        this._connection = connection;

        this._details = {
            claims: connection.claims,
            clientId: connection.clientId,
            existing: connection.existing,
            get initialClients() { return connection.initialClients; },
            get initialMessages() { return connection.initialMessages; },
            get initialSignals() { return connection.initialSignals; },
            maxMessageSize: connection.maxMessageSize,
            mode: connection.mode,
            serviceConfiguration: connection.serviceConfiguration,
            version: connection.version,
        };

        connection.on("nack", (documentId: string, message: INack[]) => {
            // Mark nacked and also pause any outbound communication
            this._nacked = true;
            this.emit("nack", documentId, message);
        });

        connection.on("disconnect", () => {
            this.emit("disconnect");
            this.close();
        });

        connection.on("op", (...args: any[]) => {
            this.emit("op", ...args);
        });

        connection.on("signal", (...args: any[]) => {
            this.emit("signal", ...args);
        });

        connection.on("error", (...args: any[]) => {
            this.emit("error", ...args);
        });
    }

    /**
     * Closes the delta connection. This disconnects the socket and clears any listeners
     */
    public close() {
        if (this._connection !== undefined) {
            const connection = this._connection;
            this._connection = undefined;
            connection.disconnect();
        }
        this.removeAllListeners();
    }

    public submit(messages: IDocumentMessage[]): void {
        this.connection.submit(messages);
    }

    public submitSignal(message: any): void {
        return this.connection.submitSignal(message);
    }
}
