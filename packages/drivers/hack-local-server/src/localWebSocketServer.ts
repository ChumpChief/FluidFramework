/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import { IPubSub, ISubscriber, WebSocketSubscriber } from "@fluidframework/server-memory-orderer";
import { IWebSocket, IWebSocketServer } from "@fluidframework/server-services-core";
import { v4 as uuid } from "uuid";

export class LocalWebSocket implements IWebSocket {
    private readonly events = new EventEmitter();
    private readonly rooms = new Set<string>();
    private readonly subscriber: ISubscriber;

    private _connected = true;
    public get connected() {
        return this._connected;
    }

    constructor(public readonly id: string, private readonly pubsub: IPubSub) {
        this.subscriber = new WebSocketSubscriber(this);
    }

    public on(event: string, listener: (...args: any[]) => void) {
        this.events.on(event, listener);
    }

    public async join(roomId: string): Promise<void> {
        this.pubsub.subscribe(roomId, this.subscriber);
        this.rooms.add(roomId);
        return;
    }

    public emit(event: string, ...args: any[]) {
        // Disconnect from the "socket" if the message is greater than 1MB
        if (JSON.stringify(args).length > 1e6) {
            this.disconnect();
            return;
        }

        this.events.emit(event, ...args);
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
        this.emit("disconnect");
    }
}

export class LocalWebSocketServer implements IWebSocketServer {
    private readonly events = new EventEmitter();

    constructor(public readonly pubsub: IPubSub) { }

    public on(event: string, listener: (...args: any[]) => void) {
        this.events.on(event, listener);
    }

    public async close(): Promise<void> {
        this.events.removeAllListeners();
    }

    public createConnection(): LocalWebSocket {
        const socket = new LocalWebSocket(uuid(), this.pubsub);
        this.events.emit("connection", socket);
        return socket;
    }
}
