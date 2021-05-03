/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { default as AbortController } from "abort-controller";
import { v4 as uuid } from "uuid";
import { ITelemetryLogger, IEventProvider } from "@fluidframework/common-definitions";
import {
    IConnectionDetails,
    IDeltaHandlerStrategy,
    IDeltaManagerEvents,
    ICriticalContainerError,
    ContainerErrorType,
    IThrottlingWarning,
    ReadOnlyInfo,
} from "@fluidframework/container-definitions";
import { assert, performance, TypedEventEmitter } from "@fluidframework/common-utils";
import { TelemetryLogger, safeRaiseEvent } from "@fluidframework/telemetry-utils";
import {
    IDocumentService,
    IDocumentDeltaConnection,
    IDocumentDeltaConnectionEvents,
} from "@fluidframework/driver-definitions";
import {
    ConnectionMode,
    IClient,
    IClientConfiguration,
    IClientDetails,
    IDocumentMessage,
    INack,
    INackContent,
    ISequencedDocumentMessage,
    ISignalClient,
    ISignalMessage,
    ITokenClaims,
    ScopeType,
} from "@fluidframework/protocol-definitions";
import {
    canRetryOnError,
    createWriteError,
    createGenericNetworkError,
    getRetryDelayFromError,
    logNetworkFailure,
    waitForConnectedState,
} from "@fluidframework/driver-utils";
import {
    CreateContainerError,
} from "@fluidframework/container-utils";

const MaxReconnectDelaySeconds = 8;
const InitialReconnectDelaySeconds = 1;
const DefaultChunkSize = 16 * 1024;

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

export interface IConnectionArgs {
    mode?: ConnectionMode;
    fetchOpsFromStorage?: boolean;
    reason: string;
}

export enum ReconnectMode {
    Never = "Never",
    Disabled = "Disabled",
    Enabled = "Enabled",
}

/**
 * Includes events emitted by the concrete implementation DeltaManager
 * but not exposed on the public interface IDeltaManager
 */
export interface IConnectionManagerInternalEvents extends IDeltaManagerEvents {
    (event: "throttled", listener: (error: IThrottlingWarning) => void);
    (event: "closed", listener: (error?: ICriticalContainerError) => void);
}

/**
 * Implementation of IDocumentDeltaConnection that does not support submitting
 * or receiving ops. Used in storage-only mode.
 */
class NoDeltaStream extends TypedEventEmitter<IDocumentDeltaConnectionEvents> implements IDocumentDeltaConnection {
    clientId: string = "storage-only client";
    claims: ITokenClaims = {
        scopes: [ScopeType.DocRead],
    } as any;
    mode: ConnectionMode = "read";
    existing: boolean = true;
    maxMessageSize: number = 0;
    version: string = "";
    initialMessages: ISequencedDocumentMessage[] = [];
    initialSignals: ISignalMessage[] = [];
    initialClients: ISignalClient[] = [];
    serviceConfiguration: IClientConfiguration = undefined as any;
    checkpointSequenceNumber?: number | undefined = undefined;
    submit(messages: IDocumentMessage[]): void {
        this.emit("nack", this.clientId, messages.map((operation) => {
            return {
                operation,
                content: { message: "Cannot submit with storage-only connection", code: 403 },
            };
        }));
    }
    submitSignal(message: any): void {
        this.emit("nack", this.clientId, {
            operation: message,
            content: { message: "Cannot submit signal with storage-only connection", code: 403 },
        });
    }
    close(): void {
    }
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
    public get active(): boolean { return this._active(); }

    public get disposed() { return this.closed; }

    public readonly clientDetails: IClientDetails;
    public get IDeltaSender() { return this; }

    /**
     * Controls whether the DeltaManager will automatically reconnect to the delta stream after receiving a disconnect.
     */
    private _reconnectMode: ReconnectMode;

    // file ACL - whether user has only read-only access to a file
    private _readonlyPermissions: boolean | undefined;

    // tracks host requiring read-only mode.
    private _forceReadonly = false;

    // Connection mode used when reconnecting on error or disconnect.
    private readonly defaultReconnectionMode: ConnectionMode;

    // The minimum sequence number and last sequence number received from the server
    private minSequenceNumber: number = 0;

    // There are three numbers we track
    // * lastQueuedSequenceNumber is the last queued sequence number. If there are gaps in seq numbers, then this number
    //   is not updated until we cover that gap, so it increases each time by 1.
    // * lastObservedSeqNumber is  an estimation of last known sequence number for container in storage. It's initially
    //   populated at web socket connection time (if storage provides that info) and is  updated once ops shows up.
    //   It's never less than lastQueuedSequenceNumber
    // * lastProcessedSequenceNumber - last processed sequence number
    private lastObservedSeqNumber: number = 0;
    private lastProcessedSequenceNumber: number = 0;
    private lastProcessedMessage: ISequencedDocumentMessage | undefined;
    private baseTerm: number = 0;

    // The sequence number we initially loaded from
    private initSequenceNumber: number = 0;

    private connectionP: Promise<IDocumentDeltaConnection> | undefined;
    private connection: IDocumentDeltaConnection | undefined;
    private clientSequenceNumber = 0;
    private clientSequenceNumberObserved = 0;
    // Counts the number of noops sent by the client which may not be acked.
    private trailingNoopCount = 0;
    private closed = false;
    private readonly deltaStreamDelayId = uuid();

    private readonly throttlingIdSet = new Set<string>();
    private timeTillThrottling: number = 0;

    // True if current connection has checkpoint information
    // I.e. we know how far behind the client was at the time of establishing connection
    private _hasCheckpointSequenceNumber = false;

    private readonly closeAbortController = new AbortController();

    /**
     * Tells if  current connection has checkpoint information.
     * I.e. we know how far behind the client was at the time of establishing connection
     */
    public get hasCheckpointSequenceNumber() {
        // Valid to be called only if we have active connection.
        assert(this.connection !== undefined, 0x0df /* "Missing active connection" */);
        return this._hasCheckpointSequenceNumber;
    }

    public get initialSequenceNumber(): number {
        return this.initSequenceNumber;
    }

    public get lastSequenceNumber(): number {
        return this.lastProcessedSequenceNumber;
    }

    public get lastMessage() {
        return this.lastProcessedMessage;
    }

    public get lastKnownSeqNumber() {
        return this.lastObservedSeqNumber;
    }

    public get referenceTerm(): number {
        return this.baseTerm;
    }

    public get minimumSequenceNumber(): number {
        return this.minSequenceNumber;
    }

    public get maxMessageSize(): number {
        return this.connection?.serviceConfiguration?.maxMessageSize
            ?? this.connection?.maxMessageSize
            ?? DefaultChunkSize;
    }

    public get version(): string {
        if (this.connection === undefined) {
            throw new Error("Cannot check version without a connection");
        }
        return this.connection.version;
    }

    public get serviceConfiguration(): IClientConfiguration | undefined {
        return this.connection?.serviceConfiguration;
    }

    public get scopes(): string[] | undefined {
        return this.connection?.claims.scopes;
    }

    public get socketDocumentId(): string | undefined {
        return this.connection?.claims.documentId;
    }

    /**
     * The current connection mode, initially read.
     */
    public get connectionMode(): ConnectionMode {
        if (this.connection === undefined) {
            return "read";
        }
        return this.connection.mode;
    }

    /**
     * Tells if container is in read-only mode.
     * Data stores should listen for "readonly" notifications and disallow user
     * making changes to data stores.
     * Readonly state can be because of no storage write permission,
     * or due to host forcing readonly mode for container.
     * It is undefined if we have not yet established websocket connection
     * and do not know if user has write access to a file.
     * @deprecated - use readOnlyInfo
     */
    public get readonly() {
        if (this._forceReadonly) {
            return true;
        }
        return this._readonlyPermissions;
    }

    /**
     * Tells if user has no write permissions for file in storage
     * It is undefined if we have not yet established websocket connection
     * and do not know if user has write access to a file.
     * @deprecated - use readOnlyInfo
     */
    public get readonlyPermissions() {
        return this._readonlyPermissions;
    }

    public get readOnlyInfo(): ReadOnlyInfo {
        const storageOnly = this.connection !== undefined && this.connection instanceof NoDeltaStream;
        if (storageOnly || this._forceReadonly || this._readonlyPermissions === true) {
            return {
                readonly: true,
                forced: this._forceReadonly,
                permissions: this._readonlyPermissions,
                storageOnly,
            };
        }

        return { readonly: this._readonlyPermissions };
    }

    /**
     * Automatic reconnecting enabled or disabled.
     * If set to Never, then reconnecting will never be allowed.
     */
    public get reconnectMode(): ReconnectMode {
        return this._reconnectMode;
    }

    public shouldJoinWrite(): boolean {
        // We don't have to wait for ack for topmost NoOps. So subtract those.
        return this.clientSequenceNumberObserved < (this.clientSequenceNumber - this.trailingNoopCount);
    }

    /**
     * Enables or disables automatic reconnecting.
     * Will throw an error if reconnectMode set to Never.
     */
    public setAutomaticReconnect(reconnect: boolean): void {
        assert(
            this._reconnectMode !== ReconnectMode.Never,
            0x0e1 /* "Cannot toggle automatic reconnect if reconnect is set to Never." */);
        this._reconnectMode = reconnect ? ReconnectMode.Enabled : ReconnectMode.Disabled;
    }

    /**
     * Sends signal to runtime (and data stores) to be read-only.
     * Hosts may have read only views, indicating to data stores that no edits are allowed.
     * This is independent from this._readonlyPermissions (permissions) and this.connectionMode
     * (server can return "write" mode even when asked for "read")
     * Leveraging same "readonly" event as runtime & data stores should behave the same in such case
     * as in read-only permissions.
     * But this.active can be used by some DDSes to figure out if ops can be sent
     * (for example, read-only view still participates in code proposals / upgrades decisions)
     *
     * Forcing Readonly does not prevent DDS from generating ops. It is up to user code to honour
     * the readonly flag. If ops are generated, they will accumulate locally and not be sent. If
     * there are pending in the outbound queue, it will stop sending until force readonly is
     * cleared.
     *
     * @param readonly - set or clear force readonly.
     */
    public forceReadonly(readonly: boolean) {
        const oldValue = this.readonly;
        this._forceReadonly = readonly;
        if (oldValue !== this.readonly) {
            let reconnect = false;
            if (this.readonly === true) {
                // If we switch to readonly while connected, we should disconnect first
                // See comment in the "readonly" event handler to deltaManager set up by
                // the ContainerRuntime constructor
                reconnect = this.disconnectFromDeltaStream("Force readonly");
            }
            safeRaiseEvent(this, this.logger, "readonly", this.readonly);
            if (reconnect) {
                // reconnect if we disconnected from before.
                this.triggerConnect({ reason: "forceReadonly", mode: "read", fetchOpsFromStorage: false });
            }
        }
    }

    private set_readonlyPermissions(readonly: boolean) {
        const oldValue = this.readonly;
        this._readonlyPermissions = readonly;
        if (oldValue !== this.readonly) {
            safeRaiseEvent(this, this.logger, "readonly", this.readonly);
        }
    }

    constructor(
        private readonly serviceProvider: () => IDocumentService | undefined,
        private client: IClient,
        private readonly logger: ITelemetryLogger,
        reconnectAllowed: boolean,
        private readonly _active: () => boolean,
    ) {
        super();

        this.clientDetails = this.client.details;
        this.defaultReconnectionMode = this.client.mode;
        this._reconnectMode = reconnectAllowed ? ReconnectMode.Enabled : ReconnectMode.Never;

        // Initially, all queues are created paused.
        // - outbound is flipped back and forth in setupNewSuccessfulConnection / disconnectFromDeltaStream
        // - inbound & inboundSignal are resumed in attachOpHandler() when we have handler setup
    }

    public dispose() {
        throw new Error("Not implemented.");
    }

    /**
     * Sets the sequence number from which inbound messages should be returned
     */
    public attachOpHandler(
        minSequenceNumber: number,
        sequenceNumber: number,
        term: number,
        handler: IDeltaHandlerStrategy,
    ) {
        this.initSequenceNumber = sequenceNumber;
        this.lastProcessedSequenceNumber = sequenceNumber;
        this.baseTerm = term;
        this.minSequenceNumber = minSequenceNumber;
        this.lastObservedSeqNumber = sequenceNumber;
    }

    private static detailsFromConnection(connection: IDocumentDeltaConnection): IConnectionDetails {
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
    }

    public async connect(args: IConnectionArgs): Promise<IConnectionDetails> {
        const connection = await this.connectCore(args);
        return ConnectionManager.detailsFromConnection(connection);
    }

    /**
     * Start the connection. Any error should result in container being close.
     * And report the error if it excape for any reason.
     * @param args - The connection arguments
     */
    private triggerConnect(args: IConnectionArgs) {
        this.connectCore(args).catch((err) => {
            // Errors are raised as "error" event and close container.
            // Have a catch-all case in case we missed something
            if (!this.closed) {
                this.logger.sendErrorEvent({ eventName: "ConnectException" }, err);
            }
        });
    }

    private async connectCore(args: IConnectionArgs): Promise<IDocumentDeltaConnection> {
        if (this.connection !== undefined) {
            return this.connection;
        }

        if (this.connectionP !== undefined) {
            return this.connectionP;
        }

        let requestedMode = args.mode ?? this.defaultReconnectionMode;

        // if we have any non-acked ops from last connection, reconnect as "write".
        // without that we would connect in view-only mode, which will result in immediate
        // firing of "connected" event from Container and switch of current clientId (as tracked
        // by all DDSes). This will make it impossible to figure out if ops actually made it through,
        // so DDSes will immediately resubmit all pending ops, and some of them will be duplicates, corrupting document
        if (this.shouldJoinWrite()) {
            requestedMode = "write";
        }

        const docService = this.serviceProvider();
        if (docService === undefined) {
            throw new Error("Container is not attached");
        }

        if (docService.policies?.storageOnly === true) {
            const connection = new NoDeltaStream();
            this.connectionP = new Promise((resolve) => {
                this.setupNewSuccessfulConnection(connection, "read");
                resolve(connection);
            });
            return this.connectionP;
        }

        // The promise returned from connectCore will settle with a resolved connection or reject with error
        const connectCore = async () => {
            let connection: IDocumentDeltaConnection | undefined;
            let delay = InitialReconnectDelaySeconds;
            let connectRepeatCount = 0;
            const connectStartTime = performance.now();

            // This loop will keep trying to connect until successful, with a delay between each iteration.
            while (connection === undefined) {
                if (this.closed) {
                    throw new Error("Attempting to connect a closed DeltaManager");
                }
                connectRepeatCount++;

                try {
                    this.client.mode = requestedMode;
                    connection = await docService.connectToDeltaStream(this.client);
                } catch (origError) {
                    const error = CreateContainerError(origError);

                    // Socket.io error when we connect to wrong socket, or hit some multiplexing bug
                    if (!canRetryOnError(origError)) {
                        this.close(error);
                        // eslint-disable-next-line @typescript-eslint/no-throw-literal
                        throw error;
                    }

                    // Log error once - we get too many errors in logs when we are offline,
                    // and unfortunately there is no reliable way to detect that.
                    if (connectRepeatCount === 1) {
                        logNetworkFailure(
                            this.logger,
                            {
                                delay, // seconds
                                eventName: "DeltaConnectionFailureToConnect",
                            },
                            origError);
                    }

                    const retryDelayFromError = getRetryDelayFromError(origError);
                    delay = retryDelayFromError ?? Math.min(delay * 2, MaxReconnectDelaySeconds);

                    if (retryDelayFromError !== undefined) {
                        this.emitDelayInfo(this.deltaStreamDelayId, retryDelayFromError, error);
                    }
                    await waitForConnectedState(delay * 1000);
                }
            }

            // If we retried more than once, log an event about how long it took
            if (connectRepeatCount > 1) {
                this.logger.sendTelemetryEvent({
                    attempts: connectRepeatCount,
                    duration: TelemetryLogger.formatTick(performance.now() - connectStartTime),
                    eventName: "MultipleDeltaConnectionFailures",
                });
            }

            this.setupNewSuccessfulConnection(connection, requestedMode);

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
    public close(error?: ICriticalContainerError): void {
        if (this.closed) {
            return;
        }
        this.closed = true;

        this.closeAbortController.abort();

        // This raises "disconnect" event if we have active connection.
        this.disconnectFromDeltaStream(error !== undefined ? `${error.message}` : "Container closed");

        // Notify everyone we are in read-only state.
        // Useful for data stores in case we hit some critical error,
        // to switch to a mode where user edits are not accepted
        this.set_readonlyPermissions(true);

        // This needs to be the last thing we do (before removing listeners), as it causes
        // Container to dispose context and break ability of data stores / runtime to "hear"
        // from delta manager, including notification (above) about readonly state.
        this.emit("closed", error);

        this.removeAllListeners();
    }

    public refreshDelayInfo(id: string) {
        this.throttlingIdSet.delete(id);
        if (this.throttlingIdSet.size === 0) {
            this.timeTillThrottling = 0;
        }
    }

    public emitDelayInfo(
        id: string,
        delaySeconds: number,
        error: ICriticalContainerError,
    ) {
        const timeNow = Date.now();
        this.throttlingIdSet.add(id);
        if (delaySeconds > 0 && (timeNow + delaySeconds > this.timeTillThrottling)) {
            this.timeTillThrottling = timeNow + delaySeconds;

            // Add 'throttling' properties to an error with safely extracted properties:
            const throttlingWarning: IThrottlingWarning = {
                errorType: ContainerErrorType.throttlingError,
                message: `Service busy/throttled: ${error.message}`,
                retryAfterSeconds: delaySeconds,
            };
            const reconfiguredError: IThrottlingWarning = {
                ...CreateContainerError(error),
                ...throttlingWarning,
            };
            this.emit("throttled", reconfiguredError);
        }
    }

    // Always connect in write mode after getting nacked.
    private readonly nackHandler = (documentId: string, messages: INack[]) => {
        const message = messages[0];
        // TODO: we should remove this check when service updates?
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        if (this._readonlyPermissions) {
            this.close(createWriteError("WriteOnReadOnlyDocument"));
        }

        // check message.content for Back-compat with old service.
        const reconnectInfo = message.content !== undefined
            ? getNackReconnectInfo(message.content) :
            createGenericNetworkError(`Nack: unknown reason`, true);

        if (this.reconnectMode !== ReconnectMode.Enabled) {
            this.logger.sendErrorEvent({
                eventName: "NackWithNoReconnect",
                reason: reconnectInfo.message,
                mode: this.connectionMode,
            });
        }

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.reconnectOnError(
            "write",
            reconnectInfo,
        );
    };

    // Connection mode is always read on disconnect/error unless the system mode was write.
    private readonly disconnectHandler = (disconnectReason) => {
        // Note: we might get multiple disconnect calls on same socket, as early disconnect notification
        // ("server_disconnect", ODSP-specific) is mapped to "disconnect"
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.reconnectOnError(
            this.defaultReconnectionMode,
            createReconnectError("Disconnect", disconnectReason),
        );
    };

    private readonly errorHandler = (error) => {
        // Observation based on early pre-production telemetry:
        // We are getting transport errors from WebSocket here, right before or after "disconnect".
        // This happens only in Firefox.
        logNetworkFailure(this.logger, { eventName: "DeltaConnectionError" }, error);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.reconnectOnError(
            this.defaultReconnectionMode,
            createReconnectError("error", error),
        );
    };

    private readonly pongHandler = (latency: number) => {
        this.emit("pong", latency);
    };

    /**
     * Once we've successfully gotten a connection, we need to set up state, attach event listeners, and process
     * initial messages.
     * @param connection - The newly established connection
     */
    private setupNewSuccessfulConnection(connection: IDocumentDeltaConnection, requestedMode: ConnectionMode) {
        // Old connection should have been cleaned up before establishing a new one
        assert(this.connection === undefined, 0x0e6 /* "old connection exists on new connection setup" */);
        this.connection = connection;

        // Does information in scopes & mode matches?
        // If we asked for "write" and got "read", then file is read-only
        // But if we ask read, server can still give us write.
        const readonly = !connection.claims.scopes.includes(ScopeType.DocWrite);
        assert(requestedMode === "read" || readonly === (this.connectionMode === "read"),
            0x0e7 /* "claims/connectionMode mismatch" */);
        assert(!readonly || this.connectionMode === "read", 0x0e8 /* "readonly perf with write connection" */);
        this.set_readonlyPermissions(readonly);

        this.refreshDelayInfo(this.deltaStreamDelayId);

        if (this.closed) {
            // Raise proper events, Log telemetry event and close connection.
            this.disconnectFromDeltaStream(`Disconnect on close`);
            return;
        }

        connection.on("nack", this.nackHandler);
        connection.on("disconnect", this.disconnectHandler);
        connection.on("error", this.errorHandler);
        connection.on("pong", this.pongHandler);

        const initialMessages = connection.initialMessages;

        this._hasCheckpointSequenceNumber = false;

        // Some storages may provide checkpointSequenceNumber to identify how far client is behind.
        const checkpointSequenceNumber = connection.checkpointSequenceNumber;
        if (checkpointSequenceNumber !== undefined) {
            this._hasCheckpointSequenceNumber = true;
            this.updateLatestKnownOpSeqNumber(checkpointSequenceNumber);
        }

        // Update knowledge of how far we are behind, before raising "connect" event
        // This is duplication of what enqueueMessages() does, but we have to raise event before we get there,
        // so duplicating update logic here as well.
        if (initialMessages.length > 0) {
            this._hasCheckpointSequenceNumber = true;
            this.updateLatestKnownOpSeqNumber(initialMessages[initialMessages.length - 1].sequenceNumber);
        }

        // Notify of the connection
        // WARNING: This has to happen before processInitialMessages() call below.
        // If not, we may not update Container.pendingClientId in time before seeing our own join session op.
        this.emit(
            "connect",
            ConnectionManager.detailsFromConnection(connection),
            this._hasCheckpointSequenceNumber ? this.lastKnownSeqNumber - this.lastSequenceNumber : undefined);
    }

    /**
     * Disconnect the current connection.
     * @param reason - Text description of disconnect reason to emit with disconnect event
     */
    private disconnectFromDeltaStream(reason: string) {
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
        connection.off("pong", this.pongHandler);

        this.emit("disconnect", reason);

        connection.close();

        return true;
    }

    /**
     * Disconnect the current connection and reconnect.
     * @param connection - The connection that wants to reconnect - no-op if it's different from this.connection
     * @param requestedMode - Read or write
     * @param reconnectInfo - Error reconnect information including whether or not to reconnect
     * @returns A promise that resolves when the connection is reestablished or we stop trying
     */
    private async reconnectOnError(
        requestedMode: ConnectionMode,
        error: ICriticalContainerError,
    ) {
        // We quite often get protocol errors before / after observing nack/disconnect
        // we do not want to run through same sequence twice.
        // If we're already disconnected/disconnecting it's not appropriate to call this again.
        assert(this.connection !== undefined, 0x0eb /* "Missing connection for reconnect" */);

        this.disconnectFromDeltaStream(error.message);

        // If reconnection is not an option, close the DeltaManager
        const canRetry = canRetryOnError(error);
        if (this.reconnectMode === ReconnectMode.Never || !canRetry) {
            // Do not raise container error if we are closing just because we lost connection.
            // Those errors (like IdleDisconnect) would show up in telemetry dashboards and
            // are very misleading, as first initial reaction - some logic is broken.
            this.close(canRetry ? undefined : error);
        }

        // If closed then we can't reconnect
        if (this.closed) {
            return;
        }

        if (this.reconnectMode === ReconnectMode.Enabled) {
            const delay = getRetryDelayFromError(error);
            if (delay !== undefined) {
                this.emitDelayInfo(this.deltaStreamDelayId, delay, error);
                await waitForConnectedState(delay * 1000);
            }

            this.triggerConnect({ reason: "reconnect", mode: requestedMode, fetchOpsFromStorage: false });
        }
    }

    private updateLatestKnownOpSeqNumber(seq: number) {
        if (this.lastObservedSeqNumber < seq) {
            this.lastObservedSeqNumber = seq;
        }
    }
}
