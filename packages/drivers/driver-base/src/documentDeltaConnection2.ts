/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentDeltaConnection, IDocumentDeltaConnectionEvents } from "@fluidframework/driver-definitions";
import { createGenericNetworkError } from "@fluidframework/driver-utils";
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
import { debug } from "./debug";

const protocolVersions = ["^0.4.0", "^0.3.0", "^0.2.0", "^0.1.0"];

/**
 * Error raising for socket.io issues
 */
function createErrorObject(handler: string, error: any, canRetry = true) {
    // Note: we suspect the incoming error object is either:
    // - a string: log it in the message (if not a string, it may contain PII but will print as [object Object])
    // - a socketError: add it to the OdspError object for driver to be able to parse it and reason
    //   over it.
    const errorObj = createGenericNetworkError(
        `socket.io error: ${handler}: ${error}`,
        canRetry,
    );

    (errorObj as any).socketError = error;
    return errorObj;
}

interface IEventListener {
    event: string;
    listener(...args: any[]): void;
}

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

        await this.initialize(connectMessage);
    }

    // Listen for ops sent before we receive a response to connect_document
    private readonly queuedMessages: ISequencedDocumentMessage[] = [];
    private readonly queuedSignals: ISignalMessage[] = [];

    private _details: IConnected | undefined;

    private readonly trackedListeners: IEventListener[] = [];

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

    private async initialize(connectMessage: IConnect) {
        this.socket.on("op", this.earlyOpHandler);
        this.socket.on("signal", this.earlySignalHandler);

        this._details = await new Promise<IConnected>((resolve, reject) => {
            // Listen for connection issues
            this.addConnectionListener("connect_error", (error) => {
                debug(`Socket connection error: [${error}]`);
                this.disconnect();
                reject(createErrorObject("connect_error", error));
            });

            // Listen for timeouts
            this.addConnectionListener("connect_timeout", () => {
                this.disconnect();
                reject(createErrorObject("connect_timeout", "Socket connection timed out"));
            });

            // Socket can be disconnected while waiting for Fluid protocol messages
            // (connect_document_error / connect_document_success)
            this.addConnectionListener("disconnect", (reason) => {
                reject(createErrorObject("disconnect", reason));
            });

            this.addConnectionListener("connect_document_success", (response: IConnected) => {
                this.removeTrackedListeners();
                resolve(response);
            });

            this.socket.on("error", ((error) => {
                // First, raise an error event, to give clients a chance to observe error contents
                // This includes "Invalid namespace" error, which we consider critical (reconnecting will not help)
                const errorObj = createErrorObject("error", error, error !== "Invalid namespace");
                reject(errorObj);
                this.emit("error", errorObj);

                // Safety net - disconnect socket if client did not do so as result of processing "error" event.
                this.disconnect();
            }));

            this.addConnectionListener("connect_document_error", ((error) => {
                // This is not an error for the socket - it's a protocol error.
                // In this case we disconnect the socket and indicate that we were unable to create the
                // DocumentDeltaConnection.
                this.disconnect();
                reject(createErrorObject("connect_document_error", error));
            }));

            this.socket.emit("connect_document", connectMessage);

            // Give extra 2 seconds for handshake on top of socket connection timeout
            setTimeout(() => {
                reject(createErrorObject("Timeout waiting for handshake from ordering service", undefined));
            }, timeoutMs + 2000);
        });
    }

    private readonly earlyOpHandler = (documentId: string, msgs: ISequencedDocumentMessage[]) => {
        debug("Queued early ops", msgs.length);
        this.queuedMessages.push(...msgs);
    };

    private readonly earlySignalHandler = (msg: ISignalMessage) => {
        debug("Queued early signals");
        this.queuedSignals.push(msg);
    };

    private removeEarlyOpHandler() {
        this.socket.removeListener("op", this.earlyOpHandler);
    }

    private removeEarlySignalHandler() {
        this.socket.removeListener("signal", this.earlySignalHandler);
    }

    private addConnectionListener(event: string, listener: (...args: any[]) => void) {
        this.socket.on(event, listener);
        this.trackedListeners.push({ event, listener });
    }

    private removeTrackedListeners() {
        for (const { event, listener } of this.trackedListeners) {
            this.socket.off(event, listener);
        }
    }
}
