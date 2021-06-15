/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IWebSocket } from "../../server-services-core";

export interface ISubscriber {
    id: string;
    readonly webSocket?: IWebSocket;
    send(topic: string, event: string, ...args: any[]): void;
}

export class WebSocketSubscriber implements ISubscriber {
    public get id(): string {
        return this.webSocket.id;
    }

    constructor(public readonly webSocket: IWebSocket) {
    }

    public send(topic: string, event: string, ...args: any[]): void {
        this.webSocket.emit(event, ...args);
    }
}

export interface IPubSub {
    // Publishes a message to the given topic
    publish(topic: string, event: string, ...args: any[]): void;
}
