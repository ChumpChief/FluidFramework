/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/common-utils";
import {
    IDocumentDeltaConnection,
} from "@fluidframework/driver-definitions";
import {
    IDocumentMessage,
    INack,
    ISequencedDocumentMessage,
    ISignalMessage,
} from "@fluidframework/protocol-definitions";
import EventEmitter from "node:events";

export class StatefulDocumentDeltaConnection extends EventEmitter {
    private _deltaConnection: IDocumentDeltaConnection | undefined;

    public get connected() {
        return this._deltaConnection !== undefined;
    }

    private get deltaConnection() {
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

    // The disconnectHandler maps to receiving a disconnect from the socket (as opposed to manually triggering a
    // disconnect).  Consumers of the stateful connection shouldn't care what the trigger was and should only
    // listen to "disconnected" emitted from the stateful connection.  Controllers will want to differentiate
    // network errors from manual disconnects when deciding whether to attempt a reconnect, so the additional
    // serverDisconnected event is provided for that purpose.
    // Consider, should a controller just listen to the "disconnect" event directly on the IDocumentDeltaConnection?
    // If so, would the connection.close() call also move up to the controller?
    private readonly disconnectHandler = (disconnectReason) => {
        assert(this._deltaConnection !== undefined, "Received disconnect event while disconnected");

        this.tearDownCurrentConnection();

        this.emit("serverDisconnected", disconnectReason);
    };

    private readonly errorHandler = (error) => {
        this.emit("error", error);
    };

    private readonly pongHandler = (latency: number) => {
        this.emit("pong", latency);
    };

    // Note that there is no "connect" event on IDocumentDeltaConnection.  Any existing non-closed
    // IDocumentDeltaConnection is implicitly expected to already be in the connected state, so by the time
    // setNewConnection is called, we need to pretend like we're just now connecting.
    public setNewConnection(connection: IDocumentDeltaConnection) {
        if (this._deltaConnection !== undefined) {
            throw new Error("Tried to set new connection, but already had one");
        }
        // Probably would be good to inspect the connection here and verify it is in fact connected and not closed,
        // but there's not currently any API surface on IDocumentDeltaConnection to expose that state.

        this._deltaConnection = connection;
        connection.on("op", this.opHandler);
        connection.on("signal", this.signalHandler);
        connection.on("nack", this.nackHandler);
        connection.on("disconnect", this.disconnectHandler);
        connection.on("error", this.errorHandler);
        connection.on("pong", this.pongHandler);

        this.emit("connected");
    }

    // Consider, move this up to controller and make tearDownCurrentConnection public?
    // This also seems like it would want the connection.close() call to move up to the controller.
    // If so, then the StatefulDocumentDeltaConnection would not modify the connection at all.
    public disconnect() {
        if (this._deltaConnection === undefined) {
            throw new Error("Tried to disconnect, but not currently connected");
        }

        this.tearDownCurrentConnection();
    }

    private tearDownCurrentConnection() {
        assert(this._deltaConnection !== undefined, "No connection to tear down");

        this._deltaConnection.off("op", this.opHandler);
        this._deltaConnection.off("signal", this.signalHandler);
        this._deltaConnection.off("nack", this.nackHandler);
        this._deltaConnection.off("disconnect", this.disconnectHandler);
        this._deltaConnection.off("error", this.errorHandler);
        this._deltaConnection.off("pong", this.pongHandler);

        // IDocumentDeltaConnection isn't designed to support reconnect, but we still must manually close it under
        // current implementation.  The purpose of this call can be thought of as a handshake indicating we agree
        // we are done with the object.
        const connection = this._deltaConnection;
        this._deltaConnection = undefined;
        connection.close();

        this.emit("disconnected");
    }
}
