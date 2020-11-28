/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";

export function safeRaiseEvent(
    emitter: EventEmitter,
    event: string,
    ...args
) {
    emitter.emit(event, ...args);
}

export function raiseConnectedEvent(
    emitter: EventEmitter,
    connected: boolean,
    clientId?: string,
) {
    if (connected) {
        emitter.emit("connected", clientId);
    } else {
        emitter.emit("disconnected");
    }
}
