/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";

import { TelemetryNullLogger } from "@fluidframework/common-utils";
import { DocumentDeltaConnection } from "@fluidframework/driver-base";
import {
    IClient,
    IConnect,
    IDocumentMessage,
} from "@fluidframework/protocol-definitions";
import {
    IDocumentDeltaConnectionMessageToServer,
    ISharedWorkerMessageFromServer,
} from "@fluidframework/server-hack-local-server";

import type { Socket } from "socket.io-client";

const testProtocolVersions = ["^0.3.0", "^0.2.0", "^0.1.0"];

// This will be the "socket" used in the tab.  Its job will be to send/receive messages to the message port and look
// "close enough" to a Socket.IO socket that we can reuse DocumentDeltaConnection.
export class SharedWorkerSocket {
    private readonly events = new EventEmitter();

    private _connected: boolean = true;
    public get connected(): boolean {
        return this._connected;
    }

    private readonly messageListener = (e) => {
        const responseData: ISharedWorkerMessageFromServer = e.data;
        if (responseData.service !== "documentDeltaConnection" || responseData.payload.type !== "emit") {
            return;
        }

        const { event, args } = responseData.payload;

        this.events.emit(event, ...args);
    };

    public constructor(private readonly port: MessagePort) {
        this.port.addEventListener("message", this.messageListener);
    }

    public emit(event: string, ...args: any[]): this {
        const message: IDocumentDeltaConnectionMessageToServer = {
            service: "documentDeltaConnection",
            payload: {
                type: "emit",
                event,
                args,
            },
        };

        this.port.postMessage(message);

        return this;
    }

    public disconnect(): this {
        this._connected = false;
        this.port.removeEventListener("message", this.messageListener);
        return this;
    }

    public on(event: string, listener: any): this {
        this.events.on(event, listener);
        return this;
    }

    public once(event: string, listener: any): this {
        this.events.once(event, listener);
        return this;
    }

    public off(event: string, listener: any): this {
        this.events.off(event, listener);
        return this;
    }

    public removeListener(event: string, listener: any): this {
        return this.off(event, listener);
    }
}

/**
 * Represents a connection to a stream of delta updates
 */
 export class SharedWorkerDocumentDeltaConnection extends DocumentDeltaConnection {
    /**
     * Create a LocalDocumentDeltaConnection
     * Handle initial messages, contents or signals if they were in queue
     *
     * @param tenantId - the ID of the tenant
     * @param id - document ID
     * @param token - authorization token for storage service
     * @param client - information about the client
     * @param webSocketServer - web socket server to create connection
     */
    public static async create(
        tenantId: string,
        id: string,
        token: string,
        client: IClient,
        port: MessagePort,
        timeoutMs = 60000,
    ): Promise<SharedWorkerDocumentDeltaConnection> {
        const socket = new SharedWorkerSocket(port);

        // Cast SharedWorkerSocket to SocketIOClient.Socket which is the socket that the base class needs.
        // This is hacky but should be fine because this delta connection is for local use only.
        const deltaConnection = new SharedWorkerDocumentDeltaConnection(socket as unknown as Socket, id);

        const connectMessage: IConnect = {
            client,
            id,
            mode: client.mode,
            tenantId,
            token,  // Token is going to indicate tenant level information, etc...
            versions: testProtocolVersions,
        };
        await deltaConnection.initialize(connectMessage, timeoutMs);
        return deltaConnection;
    }

    constructor(socket: Socket, documentId: string) {
        super(socket, documentId, new TelemetryNullLogger());
    }

    protected submitCore(type: string, messages: IDocumentMessage[]) {
        this.emitMessages(type, [messages]);
    }

    /**
     * Submits a new delta operation to the server
     */
    public submit(messages: IDocumentMessage[]): void {
        // We use a promise resolve to force a turn break given message processing is sync
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        Promise.resolve().then(() => {
            this.submitCore("submitOp", messages);
        });
    }

    /**
     * Submits a new signal to the server
     */
    public submitSignal(message: any): void {
        this.submitCore("submitSignal", [message]);
    }
}
