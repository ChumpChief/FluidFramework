/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { IRequest, IResponse, IFluidRouter } from "@fluidframework/core-interfaces";
import {
    IAudience,
    IConnectionDetails,
    IContainer,
    IContainerEvents,
    IDeltaManager,
    IRuntimeFactory,
    ICriticalContainerError,
} from "@fluidframework/container-definitions";
import {
    EventEmitterWithErrorHandling,
    raiseConnectedEvent,
} from "@fluidframework/telemetry-utils";
import {
    IDocumentDeltaStorageService,
    IDocumentDeltaService,
    IDocumentStorageService,
} from "@fluidframework/driver-definitions";
import { CreateContainerError } from "@fluidframework/container-utils";
import {
    isSystemMessage,
    ProtocolOpHandler,
} from "@fluidframework/protocol-base";
import {
    IClient,
    IDocumentMessage,
    IProcessMessageResult,
    IQuorum,
    ISequencedDocumentMessage,
    ISignalClient,
    ISignalMessage,
    MessageType,
} from "@fluidframework/protocol-definitions";

import { Audience } from "./audience";
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
    private readonly _audience: Audience;

    private _context: ContainerContext | undefined;
    private get context() {
        if (this._context === undefined) {
            throw new Error("Attempted to access context before it was defined");
        }
        return this._context;
    }
    private _protocolHandler: ProtocolOpHandler | undefined;
    private get protocolHandler() {
        if (this._protocolHandler === undefined) {
            throw new Error("Attempted to access protocolHandler before it was defined");
        }
        return this._protocolHandler;
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

    /**
     * Retrieves the audience associated with the document
     */
    public get audience(): IAudience {
        return this._audience;
    }

    constructor(
        private readonly containerRuntimeFactory: IRuntimeFactory,
        private readonly deltaService: IDocumentDeltaService,
        private readonly deltaStorageService: IDocumentDeltaStorageService,
        private readonly storageService: IDocumentStorageService,
        documentId: string,
    ) {
        super();
        this._audience = new Audience();

        this._documentId = documentId;

        this._deltaManager = this.createDeltaManager();
    }

    /**
     * Retrieves the quorum associated with the document
     */
    public getQuorum(): IQuorum {
        return this.protocolHandler.quorum;
    }

    public close(error?: ICriticalContainerError) {
        if (this._closed) {
            return;
        }
        this._closed = true;

        this._deltaManager.close(error);

        this._protocolHandler?.close();

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
        // Ideally we always connect as "read" by default.
        // Currently that works with SPO & r11s, because we get "write" connection when connecting to non-existing file.
        // We should not rely on it by (one of them will address the issue, but we need to address both)
        // 1) switching create new flow to one where we create file by posting snapshot
        // 2) Fixing quorum workflows (have retry logic)
        // That all said, "read" does not work with memorylicious workflows (that opens two simultaneous
        // connections to same file) in two ways:
        // A) creation flow breaks (as one of the clients "sees" file as existing, and hits #2 above)
        // B) Once file is created, transition from view-only connection to write does not work - some bugs to be fixed.
        const connectionArgs: IConnectionArgs = { mode: "write" };

        // Start websocket connection as soon as possible. Note that there is no op handler attached yet, but the
        // DeltaManager is resilient to this and will wait to start processing ops until after it is attached.
        const startConnectionP = this.connectToDeltaStream(connectionArgs);

        // Attach op handlers to start processing ops
        this.attachDeltaManagerOpHandler();

        // ...load in the existing quorum
        // Initialize the protocol handler
        this._protocolHandler = this.initializeProtocolState();

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

    private initializeProtocolState(): ProtocolOpHandler {
        const protocol = new ProtocolOpHandler(
            this.id, // branch
            0, // minimumSequenceNumber
            0, // sequenceNumber
            1, // term
            [], // members
            [], // proposals
            [], // values
            (key, value) => this.submitMessage(MessageType.Propose, { key, value }),
            (sequenceNumber) => this.submitMessage(MessageType.Reject, sequenceNumber));

        // Track membership changes and update connection state accordingly
        protocol.quorum.on("addMember", (clientId, details) => {
            // This is the only one that requires the pending client ID
            if (clientId === this.pendingClientId) {
                this.setConnectionState(
                    ConnectionState.Connected,
                    `joined @ ${details.sequenceNumber}`);
            }
        });

        protocol.quorum.on("removeMember", (clientId) => {
            if (clientId === this._clientId) {
                this._deltaManager.updateQuorumLeave();
            }
        });

        return protocol;
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

            this.emit("connect", opsBehind);

            if (deltaManager.connectionMode === "read") {
                this.setConnectionState(
                    ConnectionState.Connected,
                    `joined as readonly`);
            }

            // Back-compat for new client and old server.
            this._audience.clear();

            for (const priorClient of details.initialClients ?? []) {
                this._audience.addMember(priorClient.clientId, priorClient.client);
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

    private attachDeltaManagerOpHandler(): void {
        this._deltaManager.on("closed", (error?: ICriticalContainerError) => {
            this.close(error);
        });

        // If we're the outer frame, do we want to do this?
        // Begin fetching any pending deltas once we know the base sequence #. Can this fail?
        // It seems like something, like reconnection, that we would want to retry but otherwise allow
        // the document to load
        this._deltaManager.attachOpHandler(
            0, // minimumSequenceNumber
            0, // sequenceNumber
            1, // term
            {
                process: (message) => this.processRemoteMessage(message),
                processSignal: (message) => {
                    this.processSignal(message);
                },
            });
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
            this._deltaManager.updateQuorumJoin();
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
        this.protocolHandler.quorum.setConnectionState(state, this.clientId);
        raiseConnectedEvent(this, state, this.clientId);
    }

    private submitContainerMessage(type: MessageType, contents: any, batch?: boolean, metadata?: any): number {
        switch (type) {
            case MessageType.Operation:
            case MessageType.RemoteHelp:
            case MessageType.Summarize:
                break;
            default:
                this.close(CreateContainerError(`Runtime can't send arbitrary message type: ${type}`));
                return -1;
        }
        return this.submitMessage(type, contents, batch, metadata);
    }

    private submitMessage(type: MessageType, contents: any, batch?: boolean, metadata?: any): number {
        if (this.connectionState !== ConnectionState.Connected) {
            return -1;
        }

        return this._deltaManager.submit(type, contents, batch, metadata);
    }

    private processRemoteMessage(message: ISequencedDocumentMessage): IProcessMessageResult {
        const local = this._clientId === message.clientId;

        // Forward non system messages to the loaded runtime for processing
        if (!isSystemMessage(message)) {
            this.context.process(message, local, undefined);
        }

        // Allow the protocol handler to process the message
        const result = this.protocolHandler.processMessage(message, local);

        this.emit("op", message);

        return result;
    }

    private submitSignal(message: any) {
        this._deltaManager.submitSignal(JSON.stringify(message));
    }

    private processSignal(message: ISignalMessage) {
        // No clientId indicates a system signal message.
        if (message.clientId === null) {
            const innerContent = message.content as { content: any; type: string };
            if (innerContent.type === MessageType.ClientJoin) {
                const newClient = innerContent.content as ISignalClient;
                this._audience.addMember(newClient.clientId, newClient.client);
            } else if (innerContent.type === MessageType.ClientLeave) {
                const leftClientId = innerContent.content as string;
                this._audience.removeMember(leftClientId);
            }
        } else {
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
