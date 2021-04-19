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
    ConnectionMode,
    IClient,
    IClientConfiguration,
    IDocumentMessage,
    INack,
    ISequencedDocumentMessage,
    ISignalClient,
    ISignalMessage,
    ITokenClaims,
} from "@fluidframework/protocol-definitions";

export interface IStatefulDocumentDeltaConnectionEvents extends IEvent {
    (event: "connected" | "disconnected", listener: () => void);
    (event: "nack", listener: (documentId: string, message: INack[]) => void);
    (event: "disconnect", listener: (reason: any) => void);
    (event: "op", listener: (documentId: string, messages: ISequencedDocumentMessage[]) => void);
    (event: "signal", listener: (message: ISignalMessage) => void);
    (event: "pong", listener: (latency: number) => void);
    (event: "error", listener: (error: any) => void);
}

export interface IStatefulDocumentDeltaConnection extends IEventProvider<IStatefulDocumentDeltaConnectionEvents> {
    connected: boolean;
    /**
     * ClientID for the connection
     */
    clientId: string;

    /**
     * Claims for the client
     */
    claims: ITokenClaims;

    /**
     * Mode of the client
     */
    mode: ConnectionMode;

    /**
     * Whether the connection was made to a new or existing document
     */
    existing: boolean;

    /**
     * Maximum size of a message that can be sent to the server. Messages larger than this size must be chunked.
     */
    maxMessageSize: number;

    /**
     * Protocol version being used with the service
     */
    version: string;

    /**
     * Messages sent during the connection
     */
    initialMessages: ISequencedDocumentMessage[];

    /**
     * Signals sent during the connection
     */
    initialSignals: ISignalMessage[];

    /**
     * Prior clients already connected.
     */
    initialClients: ISignalClient[];

    /**
     * Configuration details provided by the service
     */
    serviceConfiguration: IClientConfiguration;

    /**
     * Last known sequence number to ordering service at the time of connection
     * It may lap actual last sequence number (quite a bit, if container  is very active).
     * But it's best information for client to figure out how far it is behind, at least
     * for "read" connections. "write" connections may use own "join" op to similar information,
     * that is likely to be more up-to-date.
     */
    checkpointSequenceNumber?: number;

    /**
     * Submit a new message to the server
     */
    submit(messages: IDocumentMessage[]): void;

    /**
     * Submit a new signal to the server
     */
    submitSignal(message: any): void;

    /**
     * Disconnects the given delta connection
     */
    close(): void;
}

export class StatefulDocumentDeltaConnection
    extends TypedEventEmitter<IStatefulDocumentDeltaConnectionEvents>
    implements IStatefulDocumentDeltaConnection {
    private connectingP: Promise<IDocumentDeltaConnection> | undefined;
    private deltaConnection: IDocumentDeltaConnection | undefined;

    public get connected() {
        return this.deltaConnection !== undefined;
    }

    public get clientId() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.clientId;
    }

    public get claims() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.claims;
    }

    public get mode() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.mode;
    }

    public get existing() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.existing;
    }

    public get maxMessageSize() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.maxMessageSize;
    }

    public get version() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.version;
    }

    public get initialMessages() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.initialMessages;
    }

    public get initialSignals() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.initialSignals;
    }

    public get initialClients() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.initialClients;
    }

    public get serviceConfiguration() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.serviceConfiguration;
    }

    public get checkpointSequenceNumber() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        return this.deltaConnection.checkpointSequenceNumber;
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

    public submit(messages: IDocumentMessage[]) {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        this.deltaConnection.submit(messages);
    }

    public submitSignal(message: any) {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        this.deltaConnection.submitSignal(message);
    }

    public close() {
        if (this.deltaConnection === undefined) {
            throw new Error("Can't access until connected");
        }
        this.deltaConnection.close();
    }
}
