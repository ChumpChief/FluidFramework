/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IEvent,
    IEventProvider,
} from "@fluidframework/common-definitions";
import { assert, TypedEventEmitter } from "@fluidframework/common-utils";
import {
    IDocumentDeltaConnection,
} from "@fluidframework/driver-definitions";
import {
    ConnectionMode,
    IClientConfiguration,
    IDocumentMessage,
    INack,
    ISequencedDocumentMessage,
    ISignalClient,
    ISignalMessage,
    ITokenClaims,
} from "@fluidframework/protocol-definitions";

export interface IStatefulDocumentDeltaConnectionEvents extends IEvent {
    (event: "connected" | "disconnected", listener: () => void);
    (event: "nack", listener: (documentId: string, message: INack[]) => void);
    (event: "disconnect", listener: (reason: any) => void);
    (event: "op", listener: (documentId: string, messages: ISequencedDocumentMessage[]) => void);
    (event: "signal", listener: (message: ISignalMessage) => void);
    (event: "pong", listener: (latency: number) => void);
    (event: "error", listener: (error: any) => void);
}

export interface IStatefulDocumentDeltaConnection extends IEventProvider<IStatefulDocumentDeltaConnectionEvents> {
    connected: boolean;
    /**
     * ClientID for the connection
     */
    clientId: string;

    /**
     * Claims for the client
     */
    claims: ITokenClaims;

    /**
     * Mode of the client
     */
    mode: ConnectionMode;

    /**
     * Whether the connection was made to a new or existing document
     */
    existing: boolean;

    /**
     * Maximum size of a message that can be sent to the server. Messages larger than this size must be chunked.
     */
    maxMessageSize: number;

    /**
     * Protocol version being used with the service
     */
    version: string;

    /**
     * Messages sent during the connection
     */
    initialMessages: ISequencedDocumentMessage[];

    /**
     * Signals sent during the connection
     */
    initialSignals: ISignalMessage[];

    /**
     * Prior clients already connected.
     */
    initialClients: ISignalClient[];

    /**
     * Configuration details provided by the service
     */
    serviceConfiguration: IClientConfiguration;

    /**
     * Last known sequence number to ordering service at the time of connection
     * It may lap actual last sequence number (quite a bit, if container  is very active).
     * But it's best information for client to figure out how far it is behind, at least
     * for "read" connections. "write" connections may use own "join" op to similar information,
     * that is likely to be more up-to-date.
     */
    checkpointSequenceNumber?: number;

    /**
     * Submit a new message to the server
     */
    submit(messages: IDocumentMessage[]): void;

    /**
     * Submit a new signal to the server
     */
    submitSignal(message: any): void;

    /**
     * Disconnects the given delta connection
     */
    close(): void;
}

export class StatefulDocumentDeltaConnection
    extends TypedEventEmitter<IStatefulDocumentDeltaConnectionEvents>
    implements IStatefulDocumentDeltaConnection {
    private _deltaConnection: IDocumentDeltaConnection | undefined;

    public get connected() {
        return this._deltaConnection !== undefined;
    }

    // TODO make this private, insist that callers retain their own reference
    public get deltaConnection() {
        if (this._deltaConnection === undefined) {
            throw new Error("Can't perform this operation in disconnected state");
        }
        return this._deltaConnection;
    }

    public get clientId() {
        return this.deltaConnection.clientId;
    }

    public get claims() {
        return this.deltaConnection.claims;
    }

    public get mode() {
        return this.deltaConnection.mode;
    }

    public get existing() {
        return this.deltaConnection.existing;
    }

    public get maxMessageSize() {
        return this.deltaConnection.maxMessageSize;
    }

    public get version() {
        return this.deltaConnection.version;
    }

    public get initialMessages() {
        return this.deltaConnection.initialMessages;
    }

    public get initialSignals() {
        return this.deltaConnection.initialSignals;
    }

    public get initialClients() {
        return this.deltaConnection.initialClients;
    }

    public get serviceConfiguration() {
        return this.deltaConnection.serviceConfiguration;
    }

    public get checkpointSequenceNumber() {
        return this.deltaConnection.checkpointSequenceNumber;
    }

    public submit(messages: IDocumentMessage[]) {
        this.deltaConnection.submit(messages);
    }

    public submitSignal(message: any) {
        this.deltaConnection.submitSignal(message);
    }

    public close() {
        this.deltaConnection.close();
    }

    private readonly opHandler = (documentId: string, messages: ISequencedDocumentMessage[]) => {
        this.emit("op", documentId, messages);
    };

    private readonly signalHandler = (message: ISignalMessage) => {
        this.emit("signal", message);
    };

    private readonly nackHandler = (documentId: string, messages: INack[]) => {
        this.emit("nack", documentId, messages);
    };

    private readonly disconnectHandler = (disconnectReason) => {
        if (this._deltaConnection === undefined) {
            // TODO allow the assert
            console.error("Connection was already released before disconnect handler");
        } else {
            this.releaseCurrentConnectionCore(disconnectReason);
        }
    };

    private readonly errorHandler = (error) => {
        // TODO emit error, once converted
        // this.emit("error", error);
    };

    private readonly pongHandler = (latency: number) => {
        this.emit("pong", latency);
    };

    public setNewConnection(connection: IDocumentDeltaConnection) {
        if (this._deltaConnection !== undefined) {
            throw new Error("Tried to set new connection, but already had one");
        }

        this._deltaConnection = connection;
        connection.on("op", this.opHandler);
        connection.on("signal", this.signalHandler);
        connection.on("nack", this.nackHandler);
        connection.on("disconnect", this.disconnectHandler);
        connection.on("error", this.errorHandler);
        connection.on("pong", this.pongHandler);

        this.emit("connected");
    }

    public releaseCurrentConnection() {
        if (this._deltaConnection === undefined) {
            throw new Error("Tried to release current connection, but not currently connected");
        }

        this.releaseCurrentConnectionCore("releaseCurrentConnection");
    }

    private releaseCurrentConnectionCore(disconnectReason: any) {
        assert(this._deltaConnection !== undefined, "No connection to tear down");
        this._deltaConnection.off("op", this.opHandler);
        this._deltaConnection.off("signal", this.signalHandler);
        this._deltaConnection.off("nack", this.nackHandler);
        this._deltaConnection.off("disconnect", this.disconnectHandler);
        this._deltaConnection.off("error", this.errorHandler);
        this._deltaConnection.off("pong", this.pongHandler);
        this._deltaConnection = undefined;

        this.emit("disconnect", disconnectReason);
    }
}
