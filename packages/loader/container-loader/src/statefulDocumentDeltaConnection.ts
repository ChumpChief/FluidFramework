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
    IDocumentDeltaConnection,
    IDocumentService,
} from "@fluidframework/driver-definitions";
import {
    IClient,
} from "@fluidframework/protocol-definitions";

export interface IStatefulDocumentDeltaConnectionEvents extends IEvent {
    (event: "connected" | "disconnected", listener: () => void);
}

export interface IStatefulDocumentDeltaConnection extends IEventProvider<IStatefulDocumentDeltaConnectionEvents> {
    connected: boolean;
}

export class StatefulDocumentDeltaConnection
    extends TypedEventEmitter<IStatefulDocumentDeltaConnectionEvents>
    implements IStatefulDocumentDeltaConnection {
    private connectingP: Promise<IDocumentDeltaConnection> | undefined;
    private deltaConnection: IDocumentDeltaConnection | undefined;

    public get connected() {
        return this.deltaConnection !== undefined;
    }

    // constructor(private readonly documentService: IDocumentService) {
    constructor(private readonly serviceProvider: () => IDocumentService | undefined) {
        super();
    }

    public async connect(client: IClient): Promise<void> {
        if (this.deltaConnection !== undefined) {
            // In connected state
            return;
        }

        if (this.connectingP !== undefined) {
            // In connecting state
            await this.connectingP;
            return;
        }

        // Disconnected with no current connect attempt
        // Would prefer to have the documentService passed in, rather than using serviceProvider()
        const documentService = this.serviceProvider();
        if (documentService === undefined) {
            throw new Error("Failed to get document service");
        }
        this.connectingP = documentService.connectToDeltaStream(client);
        this.deltaConnection = await this.connectingP;
        this.emit("connected");
    }
}
