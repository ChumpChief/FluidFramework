/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IErrorEvent } from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import {
    IClient,
    IConnect,
    IConnected,
    IDocumentMessage,
    INack,
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";
import io from "socket.io-client";

const protocolVersions = ["^0.4.0", "^0.3.0", "^0.2.0", "^0.1.0"];

const timeoutMs = 20000;

export interface IDeltaStreamEvents extends IErrorEvent {
    // Document connection state
    (event: "connected" | "disconnected", listener: () => void);

    // Protocol messages not handled at this layer, rebroadcast up to higher layers
    (event: "nack", listener: (message: INack[]) => void);
    (event: "op", listener: (message: ISequencedDocumentMessage) => void);
}

export interface IDeltaStream extends IEventProvider<IDeltaStreamEvents> {
    /**
     * Whether the stream is connected or not.
     */
    readonly connected: boolean;

    /**
     * If connected to the stream, the information about the connection.  Undefined if not connected.
     */
    readonly connectionInfo: IConnected | undefined;

    /**
     * Connect to the stream.  After resolving, messages will start flowing.
     * @param tenantId - ID for the tenant
     * @param documentId - ID for the document
     * @param token - token for access
     * @param client - client info for the connect message (TODO break this up)
     */
    connect(
        tenantId: string,
        documentId: string,
        token: string | null,
        client: IClient,
    ): Promise<void>;

    /**
     * Submit a new message to the stream
     */
    submit(message: IDocumentMessage): void;

    /**
     * Disconnect from the delta stream
     */
    disconnect();
}

/**
 * Enables connecting to, reading from, and submitting to a stream of delta updates
 */
export class SocketIODeltaStream extends TypedEventEmitter<IDeltaStreamEvents> implements IDeltaStream {
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
            if (this.connected) {
                this._connectionInfo = undefined;
                this.emit("disconnected");
            }
        });

        // Re-emit protocol messages, we don't handle them at this layer.
        this.socket.on("nack", (docId: string, messages: INack[]) => {
            // TODO - Should this also emit individual nack events?  Or is that just extra noise?
            this.emit("nack", ...messages);
        });

        this.socket.on("op", (docId: string, messages: ISequencedDocumentMessage[]) => {
            for (const message of messages) {
                this.emit("op", message);
            }
        });
    }

    /**
     * This is "document connected".  Other transports may not have a socket, and the interface shouldn't expose
     * any sort of transport-specific connection state.
     */
    public get connected() {
        return this._connectionInfo !== undefined;
    }

    public get connectionInfo() {
        return this._connectionInfo;
    }

    public async connect(
        tenantId: string,
        documentId: string,
        token: string | null,
        client: IClient,
    ) {
        const connectMessage: IConnect = {
            client,
            id: documentId,
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
            const resolveAndRemoveListeners = (connectionInfo: IConnected) => {
                removeListeners();
                this._connectionInfo = connectionInfo;
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

    /**
     * Submits a new delta operation to the server
     *
     * @param message - delta operation to submit
     */
    public submit(message: IDocumentMessage): void {
        if (this.connectionInfo === undefined) {
            throw new Error("Attempted to submit a message in disconnected state");
        }
        // I don't really want to submit as an array, but currently Tinylicious will barf if it's not.
        // submitOp is transport detail - it's not persisted in the op stream in any way
        this.socket.emit("submitOp", this.connectionInfo.clientId, [message]);
    }

    /**
     * Disconnect from the websocket
     */
    public disconnect() {
        this.socket.disconnect();
    }
}
