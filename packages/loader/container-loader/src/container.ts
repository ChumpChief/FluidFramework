/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/common-utils";
import {
    IRequest,
    IResponse,
    IFluidRouter,
} from "@fluidframework/core-interfaces";
import {
    IConnectionDetails,
    IContainer,
    IContainerEvents,
    AttachState,
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import {
    IDocumentService,
    IDocumentStorageService,
} from "@fluidframework/driver-definitions";
import {
    readAndParse,
    combineAppAndProtocolSummary,
} from "@fluidframework/driver-utils";
import {
    isSystemMessage,
} from "@fluidframework/protocol-base";
import {
    IClient,
    IDocumentAttributes,
    ISequencedDocumentMessage,
    ISignalMessage,
    ISnapshotTree,
    MessageType,
    ISummaryTree,
    SummaryType,
} from "@fluidframework/protocol-definitions";
import {
    EventEmitterWithErrorHandling,
} from "@fluidframework/telemetry-utils";
import { ContainerContext } from "./containerContext";
import { IConnectionArgs, DeltaManager } from "./deltaManager";
import { DeltaManagerProxy } from "./deltaManagerProxy";

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
    private pendingClientId: string | undefined;
    private loaded = false;
    private _attachState = AttachState.Detached;

    // Active chaincode and associated runtime
    private _storageService: IDocumentStorageService | undefined;
    private get storageService() {
        if (this._storageService === undefined) {
            throw new Error("Attempted to access storageService before it was defined");
        }
        return this._storageService;
    }

    private _clientId: string | undefined;
    private readonly _deltaManager: DeltaManager;
    private _existing: boolean | undefined;
    private service: IDocumentService | undefined;
    private _connectionState = ConnectionState.Disconnected;

    private _context: ContainerContext | undefined;
    private get context() {
        if (this._context === undefined) {
            throw new Error("Attempted to access context before it was defined");
        }
        return this._context;
    }

    private resumedOpProcessingAfterLoad = false;

    public get IFluidRouter(): IFluidRouter { return this; }

    private get connectionState(): ConnectionState {
        return this._connectionState;
    }

    public get connected(): boolean {
        return this.connectionState === ConnectionState.Connected;
    }

    /**
     * The server provided id of the client.
     * Set once this.connected is true, otherwise undefined
     */
    public get clientId(): string | undefined {
        return this._clientId;
    }

    /**
     * Flag indicating whether the document already existed at the time of load
     */
    public get existing(): boolean | undefined {
        return this._existing;
    }

    constructor() {
        super();

        this._deltaManager = this.createDeltaManager();
    }

    public get attachState(): AttachState {
        return this._attachState;
    }

    public generateCreateNewSummary() {
         // Get the document state post attach - possibly can just call attach but we need to change the
        // semantics around what the attach means as far as async code goes.
        const appSummary: ISummaryTree = this.context.createSummary();
        const protocolSummary: ISummaryTree = {
            tree: {
                attributes: {
                    content: JSON.stringify({
                        minimumSequenceNumber: this._deltaManager.minimumSequenceNumber,
                        sequenceNumber: this._deltaManager.lastSequenceNumber,
                    }),
                    type: SummaryType.Blob,
                },
            },
            type: SummaryType.Tree,
        };
        return combineAppAndProtocolSummary(appSummary, protocolSummary);
    }

    public async attach(
        documentService: IDocumentService,
        documentStorageService: IDocumentStorageService,
    ): Promise<void> {
        assert(this.loaded, "not loaded");

        // If container is already attached or attach is in progress, return.
        if (this._attachState === AttachState.Attached) {
            return;
        }

        // Only take a summary if the container is in detached state, otherwise we could have local changes.
        // In failed attach call, we would already have a summary cached.
        if (this._attachState === AttachState.Detached) {
            // Set the state as attaching as we are starting the process of attaching container.
            // This should be fired after taking the summary because it is the place where we are
            // starting to attach the container to storage.
            // Also, this should only be fired in detached container.
            this._attachState = AttachState.Attaching;
            this.emit("attaching");
        }

        // Actually go and create the resolved document
        if (this.service === undefined) {
            this.service = documentService;
        }

        if (this._storageService === undefined) {
            this._storageService = documentStorageService;
        }

        // This we can probably just pass the storage service to the blob manager - although ideally
        // there just isn't a blob manager
        this._attachState = AttachState.Attached;
        this.emit("attached");

        // Propagate current connection state through the system.
        this.propagateConnectionState();
        this.resume({ fetchOpsFromStorage: false, reason: "createDetached" });
    }

    public async request(path: IRequest): Promise<IResponse> {
        return this.context.request(path);
    }

    private resume(args: IConnectionArgs = {}) {
        // Resume processing ops
        if (!this.resumedOpProcessingAfterLoad) {
            this.resumedOpProcessingAfterLoad = true;
            this._deltaManager.inbound.resume();
            this._deltaManager.outbound.resume();
            this._deltaManager.inboundSignal.resume();
        }

        // Ensure connection to web socket
        // All errors are reported through events ("error" / "disconnected") and telemetry in DeltaManager
        this.connectToDeltaStream(args).catch(() => { });
    }

    public get storage(): IDocumentStorageService | undefined {
        return this._storageService;
    }

    private async connectToDeltaStream(args: IConnectionArgs = {}) {
        return this._deltaManager.connect(args);
    }

    /**
     * Load container.
     */
    public async load(
        runtimeFactory: IRuntimeFactory,
        documentService: IDocumentService,
        documentStorageService: IDocumentStorageService,
    ) {
        this.service = documentService;

        // Ideally we always connect as "read" by default.
        // Currently that works with SPO & r11s, because we get "write" connection when connecting to non-existing file.
        // We should not rely on it by (one of them will address the issue, but we need to address both)
        // 1) switching create new flow to one where we create file by posting snapshot
        // 2) Fixing quorum workflows (have retry logic)
        // That all said, "read" does not work with memorylicious workflows (that opens two simultaneous
        // connections to same file) in two ways:
        // A) creation flow breaks (as one of the clients "sees" file as existing, and hits #2 above)
        // B) Once file is created, transition from view-only connection to write does not work - some bugs to be fixed.

        // Start websocket connection as soon as possible. Note that there is no op handler attached yet, but the
        // DeltaManager is resilient to this and will wait to start processing ops until after it is attached.
        const startConnectionP = this.connectToDeltaStream({ mode: "write" });
        startConnectionP.catch((error) => { });

        this._storageService = documentStorageService;
        this._attachState = AttachState.Attached;

        // Fetch specified snapshot, but intentionally do not load from snapshot if specifiedVersion is null
        const maybeSnapshotTree = await this.fetchSnapshotTree();

        const attributes = await this.getDocumentAttributes(this.storageService, maybeSnapshotTree);

        // Attach op handlers to start processing ops
        this.initializeAndStartDeltaManager(attributes.minimumSequenceNumber, attributes.sequenceNumber);

        // Initialize document details - if loading a snapshot use that - otherwise we need to wait on
        // the initial details
        this._existing = maybeSnapshotTree !== undefined;

        await this.loadContext(runtimeFactory, maybeSnapshotTree);

        // Propagate current connection state through the system.
        this.propagateConnectionState();

        this.resume();

        // Internal context is fully loaded at this point
        this.loaded = true;
    }

    public async initializeDetached(runtimeFactory: IRuntimeFactory) {
        this.initializeAndStartDeltaManager(0 /* minimumSequenceNumber */, 0 /* sequenceNumber */);

        // We know this is create detached flow without snapshot.
        this._existing = false;

        // The load context - given we seeded the quorum - will be great
        await this.loadContext(runtimeFactory);

        this.propagateConnectionState();

        this.loaded = true;
    }

    private async getDocumentAttributes(
        storage: IDocumentStorageService,
        tree: ISnapshotTree | undefined,
    ): Promise<Pick<IDocumentAttributes, "minimumSequenceNumber" | "sequenceNumber">> {
        if (tree === undefined) {
            return {
                minimumSequenceNumber: 0,
                sequenceNumber: 0,
            };
        }

        const attributesHash = tree.trees[".protocol"].blobs.attributes;
        return readAndParse<Pick<IDocumentAttributes, "minimumSequenceNumber" | "sequenceNumber">>(
            storage,
            attributesHash,
        );
    }

    private createDeltaManager() {
        const client: IClient = {
            details: {
                capabilities: { interactive: true },
            },
            mode: "write",
            permission: [],
            scopes: [],
            user: { id: "" },
        };

        const deltaManager = new DeltaManager(
            () => this.service,
            client,
        );

        deltaManager.on("connect", (details: IConnectionDetails) => {
            this._connectionState = ConnectionState.Connecting;

            // Stash the clientID to detect when transitioning from connecting (socket.io channel open) to connected
            // (have received the join message for the client ID)
            // This is especially important in the reconnect case. It's possible there could be outstanding
            // ops sent by this client, so we should keep the old client id until we see our own client's
            // join message. after we see the join message for out new connection with our new client id,
            // we know there can no longer be outstanding ops that we sent with the previous client id.
            this.pendingClientId = details.clientId;

            this.setConnectionState(ConnectionState.Connected);
        });

        deltaManager.on("disconnect", () => {
            this.setConnectionState(ConnectionState.Disconnected);
        });

        return deltaManager;
    }

    private initializeAndStartDeltaManager(minimumSequenceNumber: number, sequenceNumber: number): void {
        // If we're the outer frame, do we want to do this?
        // Begin fetching any pending deltas once we know the base sequence #. Can this fail?
        // It seems like something, like reconnection, that we would want to retry but otherwise allow
        // the document to load
        this._deltaManager.on("processOp", (message) => this.processRemoteMessage(message));
        this._deltaManager.on("processSignal", (message) => this.processSignal(message));
        this._deltaManager.initialize(
            minimumSequenceNumber,
            sequenceNumber,
        );
        this._deltaManager.start();
    }

    private setConnectionState(value: ConnectionState) {
        assert(value !== ConnectionState.Connecting);
        if (this.connectionState === value) {
            // Already in the desired state - exit early
            return;
        }

        this._connectionState = value;

        if (value === ConnectionState.Connected) {
            this._clientId = this.pendingClientId;
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
        const outboundMessageType: string = type;
        switch (outboundMessageType) {
            case MessageType.Operation:
            case MessageType.RemoteHelp:
            case MessageType.Summarize:
                break;
            default:
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

    /**
     * Get the most recent snapshot, or a specific version.
     * @returns The snapshot requested, or the latest snapshot if no version was specified
     */
    private async fetchSnapshotTree(): Promise<ISnapshotTree | undefined> {
        const versions = await this.storageService.getVersions(1);
        const version = versions[0];

        if (version !== undefined) {
            return await this.storageService.getSnapshotTree(version) ?? undefined;
        }

        return undefined;
    }

    private async loadContext(
        runtimeFactory: IRuntimeFactory,
        snapshot?: ISnapshotTree,
    ) {
        this._context = await ContainerContext.createOrLoad(
            this,
            runtimeFactory,
            snapshot,
            new DeltaManagerProxy(this._deltaManager),
            (type, contents, batch, metadata) => this.submitContainerMessage(type, contents, batch, metadata),
            (message) => this.submitSignal(message),
        );
    }
}
