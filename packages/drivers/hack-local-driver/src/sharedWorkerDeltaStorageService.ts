/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDocumentDeltaStorageService, IStream } from "@fluidframework/driver-definitions";
import { streamFromMessages } from "@fluidframework/driver-utils";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";
import {
    IDeltaStorageMessageToServer,
    ISharedWorkerMessageFromServer,
} from "@fluidframework/server-hack-local-server";

import { v4 as uuid } from "uuid";

export class SharedWorkerDeltaStorageService implements IDocumentDeltaStorageService {
    public constructor(private readonly port: MessagePort) { }

    public fetchMessages(
        from: number,
        to: number | undefined,
        abortSignal?: AbortSignal,
        cachedOnly?: boolean,
    ): IStream<ISequencedDocumentMessage[]> {
        return streamFromMessages(this.getMessages(from, to));
    }

    private async getMessages(from: number, to?: number): Promise<ISequencedDocumentMessage[]> {
        const requestId = uuid();

        const messagesP = new Promise<ISequencedDocumentMessage[]>((resolve) => {
            const messageListener = (e) => {
                const responseData: ISharedWorkerMessageFromServer = e.data;
                if (responseData.service !== "deltaStorage" || responseData.requestId !== requestId) {
                    return;
                }

                resolve(responseData.payload.data);
                this.port.removeEventListener("message", messageListener);
            };
            this.port.addEventListener("message", messageListener);
        });

        const message: IDeltaStorageMessageToServer = {
            service: "deltaStorage",
            requestId,
            payload: {
                type: "getDeltas",
                from,
                to,
            },
        };
        this.port.postMessage(message);

        return messagesP;
    }
}
