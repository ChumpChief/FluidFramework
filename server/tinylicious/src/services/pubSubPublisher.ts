/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IPubSub } from "./memory-orderer";

export class PubSubPublisher implements IPubSub {
    constructor(private readonly io: SocketIO.Server) {}

    // Publish to all sockets subscribed to this topic in the SocketIO server.
    public publish(topic: string, event: string, ...args: any[]): void {
        this.io.to(topic).emit(event, ...args);
    }
}
