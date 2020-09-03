/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentDeltaConnection2, IDocumentDeltaConnectionEvents2 } from "@fluidframework/driver-definitions";
import {
    ConnectionMode,
    IClient,
    IConnect,
    IConnected,
    IDocumentMessage,
    IServiceConfiguration,
    ITokenClaims,
} from "@fluidframework/protocol-definitions";
import io from "socket.io-client";

const protocolVersions = ["^0.4.0", "^0.3.0", "^0.2.0", "^0.1.0"];

const timeoutMs = 20000;

/**
 * Represents a connection to a stream of delta updates
 */
export class DocumentDeltaConnection2 extends TypedEventEmitter<IDocumentDeltaConnectionEvents2>
    implements IDocumentDeltaConnection2
{
    private readonly socket: SocketIOClient.Socket;
    /**
     * Contains information about the connection if document-connected, or undefined if not document-connected
     * Note that there is a period where we are socket-connected but not document-connected.
     */
    private _connectionInfo: IConnected | undefined;

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
            },
        );

        // connected and disconnected events reflect document connection
        // (not websocket connection, though they are related)
        this.socket.on("disconnect", () => {
            this._connectionInfo = undefined;
            this.emit("disconnected");
        });

        // Re-emit protocol messages, we don't handle them at this layer.
        this.socket.on("nack", (...args: any[]) => {
            this.emit("nack", ...args);
        });

        this.socket.on("op", (...args: any[]) => {
            this.emit("op", ...args);
        });

        this.socket.on("signal", (...args: any[]) => {
            this.emit("signal", ...args);
        });
    }

    public get connected() {
        return this._connectionInfo;
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
        await this.connectDocument(connectMessage);
    }

    /* eslint-disable @typescript-eslint/no-use-before-define */
    private async connectWebSocket() {
        if (this.socket.connected) {
            return;
        }

        return new Promise<void>((resolve, reject) => {
            const removeListeners = () => {
                this.socket.off("connect_error", rejectAndRemoveListeners);
                this.socket.off("connect_timeout", rejectAndRemoveListeners);
                this.socket.off("error", rejectAndRemoveListeners);
                this.socket.off("connect", resolveAndRemoveListeners);
            };
            const rejectAndRemoveListeners = () => {
                removeListeners();
                reject();
            };
            const resolveAndRemoveListeners = () => {
                removeListeners();
                resolve();
            };
            this.socket.on("connect_error", rejectAndRemoveListeners);
            this.socket.on("connect_timeout", rejectAndRemoveListeners);
            this.socket.on("error", rejectAndRemoveListeners);
            this.socket.on("connect", resolveAndRemoveListeners);
            this.socket.connect();
        });
    }

    private async connectDocument(connectMessage: IConnect) {
        if (!this.socket.connected) {
            throw new Error("Cannot connectDocument until the socket is connected");
        }

        if (this.connected) {
            return;
        }

        return new Promise<void>((resolve, reject) => {
            const removeListeners = () => {
                this.socket.off("disconnect", rejectAndRemoveListeners);
                this.socket.off("connect_document_error", rejectAndRemoveListeners);
                this.socket.off("connect_document_success", resolveAndRemoveListeners);
            };
            const rejectAndRemoveListeners = () => {
                removeListeners();
                reject();
            };
            const resolveAndRemoveListeners = (details: IConnected) => {
                removeListeners();
                this._connectionInfo = details;
                this.emit("connected");
                resolve();
            };
            this.socket.on("disconnect", rejectAndRemoveListeners);
            this.socket.on("connect_document_error", rejectAndRemoveListeners);
            this.socket.on("connect_document_success", resolveAndRemoveListeners);
            this.socket.emit("connect_document", connectMessage);
        });
    }
    /* eslint-enable @typescript-eslint/no-use-before-define */

    private get connectionInfo(): IConnected {
        if (!this._connectionInfo) {
            throw new Error("Internal error: calling method before _details is initialized!");
        }
        return this._connectionInfo;
    }

    /**
     * Get the ID of the client who is sending the message
     *
     * @returns the client ID
     */
    public get clientId(): string {
        return this.connectionInfo.clientId;
    }

    /**
     * Get the mode of the client
     *
     * @returns the client mode
     */
    public get mode(): ConnectionMode {
        return this.connectionInfo.mode;
    }

    /**
     * Get the claims of the client who is sending the message
     *
     * @returns client claims
     */
    public get claims(): ITokenClaims {
        return this.connectionInfo.claims;
    }

    /**
     * Get whether or not this is an existing document
     *
     * @returns true if the document exists
     */
    public get existing(): boolean {
        return this.connectionInfo.existing;
    }

    /**
     * Get the maximum size of a message before chunking is required
     *
     * @returns the maximum size of a message before chunking is required
     */
    public get maxMessageSize(): number {
        return this.connectionInfo.maxMessageSize;
    }

    /**
     * Semver of protocol being used with the service
     */
    public get version(): string {
        return this.connectionInfo.version;
    }

    /**
     * Configuration details provided by the service
     */
    public get serviceConfiguration(): IServiceConfiguration {
        return this.connectionInfo.serviceConfiguration;
    }

    /**
     * Submits a new delta operation to the server
     *
     * @param message - delta operation to submit
     */
    public submit(message: IDocumentMessage): void {
        this.socket.emit("submitOp", this.clientId, message);
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
