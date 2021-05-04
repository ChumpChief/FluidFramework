/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider } from "@fluidframework/common-definitions";
import {
    IConnectionDetails,
    IDeltaManagerEvents,
    ICriticalContainerError,
} from "@fluidframework/container-definitions";
import { assert, TypedEventEmitter } from "@fluidframework/common-utils";
import {
    IDocumentService,
    IDocumentDeltaConnection,
} from "@fluidframework/driver-definitions";
import {
    IClient,
    IClientDetails,
    INack,
    INackContent,
} from "@fluidframework/protocol-definitions";
import {
    canRetryOnError,
    createGenericNetworkError,
    getRetryDelayFromError,
    waitForConnectedState,
} from "@fluidframework/driver-utils";
import {
    CreateContainerError,
} from "@fluidframework/container-utils";

const MaxReconnectDelaySeconds = 8;
const InitialReconnectDelaySeconds = 1;

function getNackReconnectInfo(nackContent: INackContent) {
    const reason = `Nack: ${nackContent.message}`;
    const canRetry = nackContent.code !== 403;
    return createGenericNetworkError(reason, canRetry, nackContent.retryAfter, nackContent.code);
}

function createReconnectError(prefix: string, err: any) {
    const error = CreateContainerError(err);
    const error2 = Object.create(error);
    error2.message = `${prefix}: ${error.message}`;
    error2.canRetry = true;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return error2;
}

const detailsFromConnection = (connection: IDocumentDeltaConnection): IConnectionDetails => {
    return {
        claims: connection.claims,
        clientId: connection.clientId,
        existing: connection.existing,
        checkpointSequenceNumber: connection.checkpointSequenceNumber,
        get initialClients() { return connection.initialClients; },
        maxMessageSize: connection.maxMessageSize,
        mode: connection.mode,
        serviceConfiguration: connection.serviceConfiguration,
        version: connection.version,
    };
};

/**
 * Includes events emitted by the concrete implementation DeltaManager
 * but not exposed on the public interface IDeltaManager
 */
export interface IConnectionManagerInternalEvents extends IDeltaManagerEvents {
    (event: "closed", listener: (error?: ICriticalContainerError) => void);
}

/**
 * Manages the flow of both inbound and outbound messages. This class ensures that shared objects receive delta
 * messages in order regardless of possible network conditions or timings causing out of order delivery.
 */
export class ConnectionManager
    extends TypedEventEmitter<IConnectionManagerInternalEvents>
    implements
    IEventProvider<IConnectionManagerInternalEvents>
{
    public readonly clientDetails: IClientDetails;

    private connectionP: Promise<IDocumentDeltaConnection> | undefined;
    private connection: IDocumentDeltaConnection | undefined;
    private closed = false;

    constructor(
        private readonly serviceProvider: () => IDocumentService | undefined,
        private client: IClient,
    ) {
        super();

        this.clientDetails = this.client.details;

        // Initially, all queues are created paused.
        // - outbound is flipped back and forth in setupNewSuccessfulConnection / disconnectFromDeltaStream
        // - inbound & inboundSignal are resumed in attachOpHandler() when we have handler setup
    }

    public async connect(): Promise<IConnectionDetails> {
        const connection = await this.connectCore();
        return detailsFromConnection(connection);
    }

    private async connectCore(): Promise<IDocumentDeltaConnection> {
        if (this.connection !== undefined) {
            return this.connection;
        }

        if (this.connectionP !== undefined) {
            return this.connectionP;
        }

        const docService = this.serviceProvider();
        if (docService === undefined) {
            throw new Error("Container is not attached");
        }

        // The promise returned from connectCore will settle with a resolved connection or reject with error
        const connectCore = async () => {
            let connection: IDocumentDeltaConnection | undefined;
            let delay = InitialReconnectDelaySeconds;

            // This loop will keep trying to connect until successful, with a delay between each iteration.
            while (connection === undefined) {
                if (this.closed) {
                    throw new Error("Attempting to connect a closed DeltaManager");
                }

                try {
                    // Always join write for now
                    this.client.mode = "write";
                    connection = await docService.connectToDeltaStream(this.client);
                } catch (origError) {
                    const error = CreateContainerError(origError);

                    // Socket.io error when we connect to wrong socket, or hit some multiplexing bug
                    if (!canRetryOnError(origError)) {
                        this.close();
                        // eslint-disable-next-line @typescript-eslint/no-throw-literal
                        throw error;
                    }

                    const retryDelayFromError = getRetryDelayFromError(origError);
                    delay = retryDelayFromError ?? Math.min(delay * 2, MaxReconnectDelaySeconds);

                    await waitForConnectedState(delay * 1000);
                }
            }

            this.setupNewSuccessfulConnection(connection);

            return connection;
        };

        // This promise settles as soon as we know the outcome of the connection attempt
        this.connectionP = new Promise((resolve, reject) => {
            // Regardless of how the connection attempt concludes, we'll clear the promise and remove the listener

            // Reject the connection promise if the DeltaManager gets closed during connection
            const cleanupAndReject = (error) => {
                this.connectionP = undefined;
                this.removeListener("closed", cleanupAndReject);
                reject(error);
            };
            this.on("closed", cleanupAndReject);

            // Attempt the connection
            connectCore().then((connection) => {
                this.connectionP = undefined;
                this.removeListener("closed", cleanupAndReject);
                resolve(connection);
            }).catch(cleanupAndReject);
        });

        return this.connectionP;
    }

    /**
     * Closes the connection and clears inbound & outbound queues.
     */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;

        // This raises "disconnect" event if we have active connection.
        this.disconnectFromDeltaStream();

        // This needs to be the last thing we do (before removing listeners), as it causes
        // Container to dispose context and break ability of data stores / runtime to "hear"
        // from delta manager, including notification (above) about readonly state.
        this.emit("closed");

        this.removeAllListeners();
    }

    // Always connect in write mode after getting nacked.
    private readonly nackHandler = (documentId: string, messages: INack[]) => {
        const reconnectInfo = getNackReconnectInfo(messages[0].content);

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.reconnectOnError(reconnectInfo);
    };

    // Connection mode is always read on disconnect/error unless the system mode was write.
    private readonly disconnectHandler = (disconnectReason) => {
        // Note: we might get multiple disconnect calls on same socket, as early disconnect notification
        // ("server_disconnect", ODSP-specific) is mapped to "disconnect"
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.reconnectOnError(
            createReconnectError("Disconnect", disconnectReason),
        );
    };

    private readonly errorHandler = (error) => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.reconnectOnError(
            createReconnectError("error", error),
        );
    };

    /**
     * Once we've successfully gotten a connection, we need to set up state, attach event listeners, and process
     * initial messages.
     * @param connection - The newly established connection
     */
    private setupNewSuccessfulConnection(connection: IDocumentDeltaConnection) {
        // Old connection should have been cleaned up before establishing a new one
        assert(this.connection === undefined, 0x0e6 /* "old connection exists on new connection setup" */);
        this.connection = connection;

        if (this.closed) {
            // Raise proper events, Log telemetry event and close connection.
            this.disconnectFromDeltaStream();
            return;
        }

        connection.on("nack", this.nackHandler);
        connection.on("disconnect", this.disconnectHandler);
        connection.on("error", this.errorHandler);

        // Notify of the connection
        // WARNING: This has to happen before processInitialMessages() call below.
        // If not, we may not update Container.pendingClientId in time before seeing our own join session op.
        this.emit(
            "connect",
            detailsFromConnection(connection),
        );
    }

    /**
     * Disconnect the current connection.
     * @param reason - Text description of disconnect reason to emit with disconnect event
     */
    private disconnectFromDeltaStream() {
        if (this.connection === undefined) {
            return false;
        }

        const connection = this.connection;
        // Avoid any re-entrancy - clear object reference
        this.connection = undefined;

        // Remove listeners first so we don't try to retrigger this flow accidentally through reconnectOnError
        connection.off("nack", this.nackHandler);
        connection.off("disconnect", this.disconnectHandler);
        connection.off("error", this.errorHandler);

        this.emit("disconnect");

        connection.close();

        return true;
    }

    /**
     * Disconnect the current connection and reconnect.
     * @param connection - The connection that wants to reconnect - no-op if it's different from this.connection
     * @param reconnectInfo - Error reconnect information including whether or not to reconnect
     * @returns A promise that resolves when the connection is reestablished or we stop trying
     */
    private async reconnectOnError(
        error: ICriticalContainerError,
    ) {
        // We quite often get protocol errors before / after observing nack/disconnect
        // we do not want to run through same sequence twice.
        // If we're already disconnected/disconnecting it's not appropriate to call this again.
        assert(this.connection !== undefined, 0x0eb /* "Missing connection for reconnect" */);

        this.disconnectFromDeltaStream();

        // If reconnection is not an option, close the DeltaManager
        const canRetry = canRetryOnError(error);
        if (!canRetry) {
            // Do not raise container error if we are closing just because we lost connection.
            // Those errors (like IdleDisconnect) would show up in telemetry dashboards and
            // are very misleading, as first initial reaction - some logic is broken.
            this.close();
        }

        // If closed then we can't reconnect
        if (this.closed) {
            return;
        }

        const delay = getRetryDelayFromError(error);
        if (delay !== undefined) {
            await waitForConnectedState(delay * 1000);
        }

        // Always connect in write mode for now
        await this.connectCore();
    }
}
