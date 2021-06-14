/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import { assert } from "@fluidframework/common-utils";
import {
    IDocumentDeltaConnection,
} from "@fluidframework/driver-definitions";
import {
    IDocumentMessage,
    ISequencedDocumentMessage,
    ISignalMessage,
    ScopeType,
} from "@fluidframework/protocol-definitions";

const DefaultChunkSize = 16 * 1024;

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

    public get readonlyScope() {
        return !this.claims.scopes.includes(ScopeType.DocWrite);
    }

    public get existing() {
        return this.deltaConnection.existing;
    }

    public get maxMessageSize() {
        if (!this.connected) {
            return DefaultChunkSize;
        }
        return this.deltaConnection.serviceConfiguration?.maxMessageSize
            ?? this.deltaConnection.maxMessageSize
            ?? DefaultChunkSize;
    }

    public get version() {
        return this.deltaConnection.version;
    }

    // maybe hide these as public, and instead include them as args on the connect event?
    // want to avoid manipulating the state of the connection somehow...
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

    private readonly opHandler = (documentId: string, messages: ISequencedDocumentMessage[]) => {
        this.emit("op", documentId, messages);
    };

    private readonly signalHandler = (message: ISignalMessage) => {
        this.emit("signal", message);
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

        this.emit("connected");
    }

    public tearDownCurrentConnection() {
        assert(this._deltaConnection !== undefined, "No connection to tear down");

        this._deltaConnection.off("op", this.opHandler);
        this._deltaConnection.off("signal", this.signalHandler);

        this._deltaConnection = undefined;

        this.emit("disconnected");
    }
}
