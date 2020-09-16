/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { IRequest, IResponse, IFluidRouter } from "@fluidframework/core-interfaces";
import {
    IConnectionDetails,
    IContainer,
    IContainerEvents,
    IDeltaManager,
    IRuntimeFactory,
    ICriticalContainerError,
} from "@fluidframework/container-definitions";
import {
    EventEmitterWithErrorHandling,
} from "@fluidframework/telemetry-utils";
import {
    IDocumentDeltaStorageService,
    IDocumentDeltaService,
    IDocumentStorageService,
} from "@fluidframework/driver-definitions";
import {
    isSystemMessage,
} from "@fluidframework/protocol-base";
import {
    IClient,
    IClientJoin,
    IDocumentMessage,
    ISequencedDocumentMessage,
    ISequencedDocumentSystemMessage,
    ISignalMessage,
    MessageType,
} from "@fluidframework/protocol-definitions";

import { ContainerContext } from "./containerContext";
import { IConnectionArgs, DeltaManager } from "./deltaManager";

export enum ConnectionState {
    /**
     * The document is no longer connected to the delta server
     */
    Disconnected,

    /**
     * The document has an inbound connection but is still pending for outbound deltas
     */
    Connecting,

    /**
     * The document is fully connected
     */
    Connected,
}

export class Container extends EventEmitterWithErrorHandling<IContainerEvents> implements IContainer {
    /**
     * Load container.
     */
    public static async load(
        documentId: string,
        documentService: IDocumentDeltaService,
        deltaStorageService: IDocumentDeltaStorageService,
        storageService: IDocumentStorageService,
        containerRuntimeFactory: IRuntimeFactory,
    ): Promise<Container> {
        const container = new Container(
            containerRuntimeFactory,
            documentService,
            deltaStorageService,
            storageService,
            documentId,
        );
        await container.load();
        return container;
    }

    private pendingClientId: string | undefined;
    private loaded = false;

    private _clientId: string | undefined;
    private readonly _documentId: string | undefined;
    private readonly _deltaManager: DeltaManager;
    private _existing: boolean | undefined;
    private _connectionState = ConnectionState.Disconnected;

    private _context: ContainerContext | undefined;
    private get context() {
        if (this._context === undefined) {
            throw new Error("Attempted to access context before it was defined");
        }
        return this._context;
    }

    private resumedOpProcessingAfterLoad = false;

    private _closed = false;

    public get IFluidRouter(): IFluidRouter { return this; }

    /**
     * {@inheritDoc DeltaManager.readonly}
     */
    public get readonly() {
        return this._deltaManager.readonly;
    }

    /**
     * {@inheritDoc DeltaManager.readonlyPermissions}
     */
    public get readonlyPermissions() {
        return this._deltaManager.readonlyPermissions;
    }

    public forceReadonly(readonly: boolean) {
        this._deltaManager.forceReadonly(readonly);
    }

    public get closed(): boolean {
        return this._closed;
    }

    public get id(): string {
        return this._documentId ?? "";
    }

    public get deltaManager(): IDeltaManager<ISequencedDocumentMessage, IDocumentMessage> {
        return this._deltaManager;
    }

    public get connectionState(): ConnectionState {
        return this._connectionState;
    }

    public get connected(): boolean {
        return this.connectionState === ConnectionState.Connected;
    }

    public get canReconnect(): boolean {
        return true;
    }

    /**
     * The server provided id of the client.
     * Set once this.connected is true, otherwise undefined
     */
    public get clientId(): string | undefined {
        return this._clientId;
    }

    /**
     * The server provided claims of the client.
     * Set once this.connected is true, otherwise undefined
     */
    public get scopes(): string[] | undefined {
        return this._deltaManager.scopes;
    }

    /**
     * Flag indicating whether the document already existed at the time of load
     */
    public get existing(): boolean | undefined {
        return this._existing;
    }

    constructor(
        private readonly containerRuntimeFactory: IRuntimeFactory,
        private readonly deltaService: IDocumentDeltaService,
        private readonly deltaStorageService: IDocumentDeltaStorageService,
        private readonly storageService: IDocumentStorageService,
        documentId: string,
    ) {
        super();

        this._documentId = documentId;

        this._deltaManager = this.createDeltaManager();
    }

    public close(error?: ICriticalContainerError) {
        if (this._closed) {
            return;
        }
        this._closed = true;

        this._deltaManager.close(error);

        this._context?.dispose(error !== undefined ? new Error(error.message) : undefined);

        assert.strictEqual(this.connectionState, ConnectionState.Disconnected, "disconnect event was not raised!");

        this.emit("closed", error);

        this.removeAllListeners();
    }

    public async request(path: IRequest): Promise<IResponse> {
        return this.context.request(path);
    }

    public setAutoReconnect(reconnect: boolean) {
        assert(this.resumedOpProcessingAfterLoad);

        if (reconnect && this.closed) {
            throw new Error("Attempting to setAutoReconnect() a closed DeltaManager");
        }

        this._deltaManager.setAutomaticReconnect(reconnect);

        if (reconnect) {
            // Ensure connection to web socket
            this.connectToDeltaStream({ reason: "autoReconnect" }).catch((error) => { });
        }
    }

    public resume() {
        this.resumeInternal();
    }

    private resumeInternal(args: IConnectionArgs = {}) {
        if (this.closed) {
            throw new Error("Attempting to setAutoReconnect() a closed DeltaManager");
        }

        // Resume processing ops
        assert(!this.resumedOpProcessingAfterLoad);
        this.resumedOpProcessingAfterLoad = true;
        this._deltaManager.inbound.resume();
        this._deltaManager.outbound.resume();
        this._deltaManager.inboundSignal.resume();

        // Ensure connection to web socket
        // All errors are reported through events ("error" / "disconnected") and telemetry in DeltaManager
        this.connectToDeltaStream(args).catch(() => { });
    }

    public get storage(): IDocumentStorageService {
        return this.storageService;
    }

    private async connectToDeltaStream(args: IConnectionArgs = {}) {
        // All agents need "write" access, including summarizer.
        if (!this.canReconnect || !this.client.details.capabilities.interactive) {
            args.mode = "write";
        }

        return this._deltaManager.connect(args);
    }

    /**
     * Load container.
     *
     * @param specifiedVersion - one of the following
     *   - null: use ops, no snapshots
     *   - undefined - fetch latest snapshot
     *   - otherwise, version sha to load snapshot
     * @param pause - start the container in a paused state
     */
    private async load() {
        // Start websocket connection as soon as possible. Note that there is no op handler attached yet, but the
        // DeltaManager is resilient to this and will wait to start processing ops until after it is attached.
        const startConnectionP = this.connectToDeltaStream({ mode: "write" });

        // Attach op handlers to start processing ops
        this._deltaManager.attachOpHandler({
            process: (message) => this.processRemoteMessage(message),
            processSignal: (message) => {
                this.processSignal(message);
            },
        });
        this._existing = await startConnectionP.then((details) => details.existing);

        await this.loadContext();

        // Propagate current connection state through the system.
        this.propagateConnectionState();

        this.resume();

        // Internal context is fully loaded at this point
        this.loaded = true;

        return {
            existing: this._existing,
            sequenceNumber: 0,
            version: undefined,
        };
    }

    private get client(): IClient {
        const client: IClient = {
            details: {
                capabilities: { interactive: true },
            },
            mode: "read", // default reconnection mode on lost connection / connection error
            permission: [],
            scopes: [],
            user: { id: "" },
        };

        return client;
    }

    private createDeltaManager() {
        const deltaManager = new DeltaManager(
            this.deltaService,
            this.deltaStorageService,
            this.client,
            this.canReconnect,
        );

        deltaManager.on("connect", (details: IConnectionDetails, opsBehind?: number) => {
            this._connectionState = ConnectionState.Connecting;

            // Stash the clientID to detect when transitioning from connecting (socket.io channel open) to connected
            // (have received the join message for the client ID)
            // This is especially important in the reconnect case. It's possible there could be outstanding
            // ops sent by this client, so we should keep the old client id until we see our own client's
            // join message. after we see the join message for out new connection with our new client id,
            // we know there can no longer be outstanding ops that we sent with the previous client id.
            this.pendingClientId = details.clientId;

            if (deltaManager.connectionMode === "read") {
                this.setConnectionState(
                    ConnectionState.Connected,
                    `joined as readonly`);
            }
        });

        deltaManager.on("disconnect", (reason: string) => {
            this.setConnectionState(ConnectionState.Disconnected, reason);
        });

        deltaManager.on("pong", (latency) => {
            this.emit("pong", latency);
        });

        deltaManager.on("processTime", (time) => {
            this.emit("processTime", time);
        });

        deltaManager.on("readonly", (readonly) => {
            this.emit("readonly", readonly);
        });

        return deltaManager;
    }

    private setConnectionState(
        value: ConnectionState,
        reason: string) {
        assert(value !== ConnectionState.Connecting);
        if (this.connectionState === value) {
            // Already in the desired state - exit early
            return;
        }

        this._connectionState = value;

        if (value === ConnectionState.Connected) {
            this._clientId = this.pendingClientId;
            this._deltaManager.setConnected();
        } else if (value === ConnectionState.Disconnected) {
            // Important as we process our own joinSession message through delta request
            this.pendingClientId = undefined;
        }

        if (this.loaded) {
            this.propagateConnectionState();
        }
    }

    private propagateConnectionState() {
        const state = this._connectionState === ConnectionState.Connected;
        this.context.setConnectionState(state, this.clientId);
    }

    private submitContainerMessage(type: MessageType, contents: any, batch?: boolean, metadata?: any): number {
        if (type !== MessageType.Operation) {
            throw new Error(`Runtime can't send arbitrary message type: ${type}`);
        }

        return this.submitMessage(type, contents, batch, metadata);
    }

    private submitMessage(type: MessageType, contents: any, batch?: boolean, metadata?: any): number {
        if (this.connectionState !== ConnectionState.Connected) {
            return -1;
        }

        return this._deltaManager.submit(type, contents, batch, metadata);
    }

    private processRemoteMessage(message: ISequencedDocumentMessage): void {
        const local = this._clientId === message.clientId;

        // Forward non system messages to the loaded runtime for processing
        if (!isSystemMessage(message)) {
            this.context.process(message, local, undefined);
        }

        // Leftover from quorum's addMember
        if (message.type === MessageType.ClientJoin) {
            const joinMessage = message as ISequencedDocumentSystemMessage;
            const join = JSON.parse(joinMessage.data) as IClientJoin;
            if (join.clientId === this.pendingClientId) {
                this.setConnectionState(
                    ConnectionState.Connected,
                    `joined @ ${joinMessage.sequenceNumber}`);
            }
        }

        this.emit("op", message);
    }

    private submitSignal(message: any) {
        this._deltaManager.submitSignal(JSON.stringify(message));
    }

    private processSignal(message: ISignalMessage) {
        // No clientId indicates a system signal message.
        if (message.clientId !== null) {
            const local = this._clientId === message.clientId;
            this.context.processSignal(message, local);
        }
    }

    private async loadContext() {
        this._context = await ContainerContext.createOrLoad(
            this,
            this.containerRuntimeFactory,
            (type, contents, batch, metadata) => this.submitContainerMessage(type, contents, batch, metadata),
            (message) => this.submitSignal(message),
        );
    }
}
