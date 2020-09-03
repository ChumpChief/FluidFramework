/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentDeltaConnection, IDocumentDeltaConnectionEvents } from "@fluidframework/driver-definitions";
import {
    ConnectionMode,
    IClient,
    IConnect,
    IConnected,
    IDocumentMessage,
    ISequencedDocumentMessage,
    IServiceConfiguration,
    ISignalClient,
    ISignalMessage,
    ITokenClaims,
} from "@fluidframework/protocol-definitions";
import io from "socket.io-client";

const protocolVersions = ["^0.4.0", "^0.3.0", "^0.2.0", "^0.1.0"];

const timeoutMs = 20000;

/**
 * Represents a connection to a stream of delta updates
 */
export class DocumentDeltaConnection2 extends TypedEventEmitter<IDocumentDeltaConnectionEvents>
    implements IDocumentDeltaConnection
{
    private readonly socket: SocketIOClient.Socket
    /**
     * @param socket - websocket to be used
     */
    public constructor(
        documentId: string,
        tenantId: string,
        url: string,
    ) {
        super();

        this.socket = io(
            url,
            {
                autoConnect: false,
                query: {
                    documentId,
                    tenantId,
                },
                reconnection: false,
                transports: ["websocket"],
                timeout: timeoutMs,
            });

        this.socket.on("nack", (...args: any[]) => {
            this.emit("nack", ...args);
        });

        this.socket.on("disconnect", (...args: any[]) => {
            this.emit("disconnect", ...args);
        });

        this.socket.on("op", (...args: any[]) => {
            this.emit("op", ...args);
        });

        this.socket.on("signal", (...args: any[]) => {
            this.emit("signal", ...args);
        });
    }

    public async connect(
        tenantId: string,
        id: string,
        token: string | null,
        client: IClient,
    ) {
        const connectMessage: IConnect = {
            client,
            id,
            mode: client.mode,
            tenantId,
            token,  // Token is going to indicate tenant level information, etc...
            versions: protocolVersions,
        };

        await this.connectWebSocket();
        this._details = await this.connectDocument(connectMessage);
    }

    private async connectWebSocket() {
        return new Promise<void>((resolve, reject) => {
            const removeListeners = () => {
                this.socket.off("connect_error", rejectAndRemoveListeners);
                this.socket.off("connect_timeout", rejectAndRemoveListeners);
                this.socket.off("error", rejectAndRemoveListeners);
                this.socket.off("connect", resolveAndRemoveListeners);
            };
            const rejectAndRemoveListeners = () => {
                reject();
                removeListeners();
            };
            const resolveAndRemoveListeners = () => {
                resolve();
                removeListeners();
            };
            this.socket.on("connect_error", rejectAndRemoveListeners);
            this.socket.on("connect_timeout", rejectAndRemoveListeners);
            this.socket.on("error", rejectAndRemoveListeners);
            this.socket.on("connect", resolveAndRemoveListeners);
            this.socket.connect();
        });
    }

    private async connectDocument(connectMessage: IConnect) {
        return new Promise<IConnected>((resolve, reject) => {
            const removeListeners = () => {
                this.socket.off("connect_document_error", rejectAndRemoveListeners);
                this.socket.off("connect_document_success", resolveAndRemoveListeners);
            };
            const rejectAndRemoveListeners = () => {
                reject();
                removeListeners();
            };
            const resolveAndRemoveListeners = (details: IConnected) => {
                resolve(details);
                removeListeners();
            };
            this.socket.on("connect_document_error", rejectAndRemoveListeners);
            this.socket.on("connect_document_success", resolveAndRemoveListeners);
            this.socket.emit("connect_document", connectMessage);
        });
    }

    // Listen for ops sent before we receive a response to connect_document
    private readonly queuedMessages: ISequencedDocumentMessage[] = [];
    private readonly queuedSignals: ISignalMessage[] = [];

    private _details: IConnected | undefined;

    private get details(): IConnected {
        if (!this._details) {
            throw new Error("Internal error: calling method before _details is initialized!");
        }
        return this._details;
    }

    /**
     * Get the ID of the client who is sending the message
     *
     * @returns the client ID
     */
    public get clientId(): string {
        return this.details.clientId;
    }

    /**
     * Get the mode of the client
     *
     * @returns the client mode
     */
    public get mode(): ConnectionMode {
        return this.details.mode;
    }

    /**
     * Get the claims of the client who is sending the message
     *
     * @returns client claims
     */
    public get claims(): ITokenClaims {
        return this.details.claims;
    }

    /**
     * Get whether or not this is an existing document
     *
     * @returns true if the document exists
     */
    public get existing(): boolean {
        return this.details.existing;
    }

    /**
     * Get the maximum size of a message before chunking is required
     *
     * @returns the maximum size of a message before chunking is required
     */
    public get maxMessageSize(): number {
        return this.details.maxMessageSize;
    }

    /**
     * Semver of protocol being used with the service
     */
    public get version(): string {
        return this.details.version;
    }

    /**
     * Configuration details provided by the service
     */
    public get serviceConfiguration(): IServiceConfiguration {
        return this.details.serviceConfiguration;
    }

    /**
     * Get messages sent during the connection
     *
     * @returns messages sent during the connection
     */
    public get initialMessages(): ISequencedDocumentMessage[] {
        // We will lose ops and perf will tank as we need to go to storage to become current!
        assert(this.listeners("op").length !== 0, "No op handler is setup!");

        this.removeEarlyOpHandler();

        if (this.queuedMessages.length > 0) {
            // Some messages were queued.
            // add them to the list of initialMessages to be processed
            this.details.initialMessages.push(...this.queuedMessages);
            this.details.initialMessages.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
            this.queuedMessages.length = 0;
        }
        return this.details.initialMessages;
    }

    /**
     * Get signals sent during the connection
     *
     * @returns signals sent during the connection
     */
    public get initialSignals(): ISignalMessage[] {
        this.removeEarlySignalHandler();

        assert(this.listeners("signal").length !== 0, "No signal handler is setup!");

        if (this.queuedSignals.length > 0) {
            // Some signals were queued.
            // add them to the list of initialSignals to be processed
            this.details.initialSignals.push(...this.queuedSignals);
            this.queuedSignals.length = 0;
        }
        return this.details.initialSignals;
    }

    /**
     * Get initial client list
     *
     * @returns initial client list sent during the connection
     */
    public get initialClients(): ISignalClient[] {
        return this.details.initialClients;
    }

    /**
     * Submits a new delta operation to the server
     *
     * @param message - delta operation to submit
     */
    public submit(messages: IDocumentMessage[]): void {
        for (const message of messages) {
            this.socket.emit("submitOp", this.clientId, message);
        }
    }

    /**
     * Submits a new signal to the server
     *
     * @param message - signal to submit
     */
    public submitSignal(message: IDocumentMessage): void {
        this.socket.emit("submitSignal", this.clientId, message);
    }

    /**
     * Disconnect from the websocket
     */
    public disconnect() {
        this.socket.disconnect();
    }
}
