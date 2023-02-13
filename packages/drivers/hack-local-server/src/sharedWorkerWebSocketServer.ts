/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import { IPubSub, ISubscriber, WebSocketSubscriber } from "@fluidframework/server-memory-orderer";
import { IWebSocket, IWebSocketServer } from "@fluidframework/server-services-core";
import { v4 as uuid } from "uuid";
import { IDocumentDeltaConnectionMessageFromServer, ISharedWorkerMessageToServer } from "./messageInterfaces";

export class SharedWorkerWebSocket implements IWebSocket {
    private readonly events = new EventEmitter();
    private readonly rooms = new Set<string>();
    private readonly subscriber: ISubscriber;

    private _connected = true;
    public get connected() {
        return this._connected;
    }

    constructor(public readonly id: string, private readonly pubsub: IPubSub, private readonly port: MessagePort) {
        this.port.addEventListener("message", this.handlePortMessage);
        this.subscriber = new WebSocketSubscriber(this);
    }

    private readonly handlePortMessage = (event: MessageEvent) => {
        const message: ISharedWorkerMessageToServer = event.data;
        if (message.service !== "documentDeltaConnection") {
            throw new Error(`Unexpected service type requested on this port: ${message.service}`);
        }

        if (message.payload.type !== "emit") {
            throw new Error(`Unexpected message type on this port: ${message.payload.type}`);
        }
        console.log("Got message:", message.payload.event, message.payload.args);
        this.events.emit(message.payload.event, ...message.payload.args);
    };

    public on(event: string, listener: (...args: any[]) => void) {
        this.events.on(event, listener);
    }

    // called by alfred in response to the socket emitting a connect_document (documentdeltaconnection sends it)
    public async join(roomId: string): Promise<void> {
        this.pubsub.subscribe(roomId, this.subscriber);
        this.rooms.add(roomId);
        return;
    }

    // "emit" here means emit over the "socket"
    public emit(event: string, ...args: any[]) {
        // Disconnect from the "socket" if the message is greater than 1MB
        if (JSON.stringify(args).length > 1e6) {
            this.disconnect();
            return;
        }

        const message: IDocumentDeltaConnectionMessageFromServer = {
            service: "documentDeltaConnection",
            payload: {
                type: "emit",
                event,
                args,
            },
        };

        this.port.postMessage(message);
    }

    public emitToRoom(roomId: string, event: string, ...args: any[]) {
        this.pubsub.publish(roomId, event, ...args);
    }

    public removeListener(event: string, listener: (...args: any[]) => void) {
        this.events.removeListener(event, listener);
    }

    // Add `off` method the socket which is called by the base class `DocumentDeltaConnection` to remove
    // event listeners.
    // We may have to add more methods from SocketIOClient.Socket if they start getting used.
    public off(event: string, listener: (...args: any[]) => void) {
        this.removeListener(event, listener);
        return this;
    }

    public disconnect(close?: boolean) {
        for (const roomId of this.rooms) {
            this.pubsub.unsubscribe(roomId, this.subscriber);
        }
        this._connected = false;
        this.port.removeEventListener("message", this.handlePortMessage);
        this.emit("disconnect");
    }
}

export class SharedWorkerWebSocketServer implements IWebSocketServer {
    private readonly events = new EventEmitter();

    constructor(public readonly pubsub: IPubSub) {
    }

    public on(event: string, listener: (...args: any[]) => void) {
        this.events.on(event, listener);
    }

    public async close(): Promise<void> {
        this.events.removeAllListeners();
    }

    public addConnection(port: MessagePort): SharedWorkerWebSocket {
        const socket = new SharedWorkerWebSocket(uuid(), this.pubsub, port);
        // Alfred is listening for this event to actually set up the socket.
        this.events.emit("connection", socket);
        return socket;
    }
}
