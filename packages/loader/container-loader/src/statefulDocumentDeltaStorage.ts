/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IEvent,
    IEventProvider,
} from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import {
    IDocumentDeltaStorageService,
    IDocumentService,
    IStream,
} from "@fluidframework/driver-definitions";
import {
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";

export interface IStatefulDocumentDeltaStorageEvents extends IEvent {
    (event: "connected" | "disconnected", listener: () => void);
}

export interface IStatefulDocumentDeltaStorage extends IEventProvider<IStatefulDocumentDeltaStorageEvents> {
    connected: boolean;
    fetchMessages(from: number,
        to: number | undefined,
        abortSignal?: AbortSignal,
        cachedOnly?: boolean,
    ): IStream<ISequencedDocumentMessage[]>;
}

export class StatefulDocumentDeltaStorage
    extends TypedEventEmitter<IStatefulDocumentDeltaStorageEvents>
    implements IStatefulDocumentDeltaStorage {
    private connectingP: Promise<IDocumentDeltaStorageService> | undefined;
    private deltaStorage: IDocumentDeltaStorageService | undefined;

    public get connected() {
        return this.deltaStorage !== undefined;
    }

    constructor(private readonly documentService: IDocumentService) {
        super();
    }

    public async connect(): Promise<void> {
        if (this.deltaStorage !== undefined) {
            // In connected state
            return;
        }

        if (this.connectingP !== undefined) {
            // In connecting state
            await this.connectingP;
            return;
        }

        // Disconnected with no current connect attempt
        this.connectingP = this.documentService.connectToDeltaStorage();
        this.deltaStorage = await this.connectingP;
        this.emit("connected");
    }

    public fetchMessages(from: number,
        to: number | undefined,
        abortSignal?: AbortSignal,
        cachedOnly?: boolean,
    ): IStream<ISequencedDocumentMessage[]> {
        if (this.deltaStorage === undefined) {
            throw new Error("Can't fetch messages until connected");
        }
        return this.deltaStorage.fetchMessages(from, to, abortSignal, cachedOnly);
    }
}
