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
    ICriticalContainerError,
    AttachState,
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { CreateContainerError, GenericError } from "@fluidframework/container-utils";
import {
    IDocumentService,
    IDocumentStorageService,
} from "@fluidframework/driver-definitions";
import {
    readAndParse,
    combineAppAndProtocolSummary,
    readAndParseFromBlobs,
} from "@fluidframework/driver-utils";
import {
    isSystemMessage,
    ProtocolOpHandler,
} from "@fluidframework/protocol-base";
import {
    IClient,
    ICommittedProposal,
    IDocumentAttributes,
    IProcessMessageResult,
    ISequencedClient,
    ISequencedDocumentMessage,
    ISequencedProposal,
    ISignalMessage,
    ISnapshotTree,
    MessageType,
    ISummaryTree,
} from "@fluidframework/protocol-definitions";
import {
    EventEmitterWithErrorHandling,
    raiseConnectedEvent,
} from "@fluidframework/telemetry-utils";
import { ContainerContext } from "./containerContext";
import { IConnectionArgs, DeltaManager } from "./deltaManager";
import { DeltaManagerProxy } from "./deltaManagerProxy";

interface ILocalSequencedClient extends ISequencedClient {
    shouldHaveLeft?: boolean;
}

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

    private get closed(): boolean {
        return this._closed;
    }

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

    private close(error?: ICriticalContainerError) {
        if (this._closed) {
            return;
        }
        this._closed = true;

        this._protocolHandler?.close();

        assert(this.connectionState === ConnectionState.Disconnected, "disconnect event was not raised!");

        this.emit("closed", error);

        this.removeAllListeners();
    }

    public get attachState(): AttachState {
        return this._attachState;
    }

    public generateCreateNewSummary() {
         // Get the document state post attach - possibly can just call attach but we need to change the
        // semantics around what the attach means as far as async code goes.
        const appSummary: ISummaryTree = this.context.createSummary();
        if (this.protocolHandler === undefined) {
            throw new Error("Protocol Handler is undefined");
        }
        const protocolSummary = this.protocolHandler.captureSummary();
        return combineAppAndProtocolSummary(appSummary, protocolSummary);
    }

    public async attach(
        documentService: IDocumentService,
        documentStorageService: IDocumentStorageService,
    ): Promise<void> {
        assert(this.loaded, "not loaded");
        assert(!this.closed, "closed");

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
        if (this.closed) {
            throw new Error("Attempting to resume() a closed DeltaManager");
        }

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
        // All agents need "write" access, including summarizer.
        if (!this.client.details.capabilities.interactive) {
            args.mode = "write";
        }

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
        this.attachDeltaManagerOpHandler(attributes);

        // ...load in the existing quorum
        // Initialize the protocol handler
        const protocolHandlerP =
            this.loadAndInitializeProtocolState(attributes, this.storageService, maybeSnapshotTree);

        let loadDetailsP: Promise<void>;

        // Initialize document details - if loading a snapshot use that - otherwise we need to wait on
        // the initial details
        if (maybeSnapshotTree !== undefined) {
            this._existing = true;
            loadDetailsP = Promise.resolve();
        } else {
            // Intentionally don't .catch on this promise - we'll let any error throw below in the await.
            loadDetailsP = startConnectionP.then((details) => {
                this._existing = details.existing;
            });
        }

        // LoadContext directly requires protocolHandler to be ready, and eventually calls
        // instantiateRuntime which will want to know existing state.  Wait for these promises to finish.
        [this._protocolHandler] = await Promise.all([protocolHandlerP, loadDetailsP]);

        await this.loadContext(runtimeFactory, maybeSnapshotTree);

        // Propagate current connection state through the system.
        this.propagateConnectionState();

        this.resume();

        // Internal context is fully loaded at this point
        this.loaded = true;
    }

    public async initializeDetached(runtimeFactory: IRuntimeFactory) {
        const attributes: IDocumentAttributes = {
            branch: "",
            sequenceNumber: 0,
            term: 1,
            minimumSequenceNumber: 0,
        };

        const members: [string, ISequencedClient][] = [];
        const proposals: [number, ISequencedProposal, string[]][] = [];
        const values: [string, ICommittedProposal][] = [];

        this.attachDeltaManagerOpHandler(attributes);

        // We know this is create detached flow without snapshot.
        this._existing = false;

        // Need to just seed the source data in the code quorum. Quorum itself is empty
        this._protocolHandler = this.initializeProtocolState(
            attributes,
            members,
            proposals,
            values);

        // The load context - given we seeded the quorum - will be great
        await this.loadContext(runtimeFactory);

        this.propagateConnectionState();

        this.loaded = true;
    }

    private async getDocumentAttributes(
        storage: IDocumentStorageService | undefined,
        tree: ISnapshotTree | undefined,
    ): Promise<IDocumentAttributes> {
        if (tree === undefined) {
            return {
                branch: "", // was documentId
                minimumSequenceNumber: 0,
                sequenceNumber: 0,
                term: 1,
            };
        }

        // Back-compat: old docs would have ".attributes" instead of "attributes"
        const attributesHash = ".protocol" in tree.trees
            ? tree.trees[".protocol"].blobs.attributes
            : tree.blobs[".attributes"];

        const attributes = storage !== undefined ? await readAndParse<IDocumentAttributes>(storage, attributesHash)
            : readAndParseFromBlobs<IDocumentAttributes>(tree.trees[".protocol"].blobs, attributesHash);

        return attributes;
    }

    private async loadAndInitializeProtocolState(
        attributes: IDocumentAttributes,
        storage: IDocumentStorageService | undefined,
        snapshot: ISnapshotTree | undefined,
    ): Promise<ProtocolOpHandler> {
        let members: [string, ISequencedClient][] = [];
        let proposals: [number, ISequencedProposal, string[]][] = [];
        let values: [string, any][] = [];

        if (snapshot !== undefined) {
            const baseTree = ".protocol" in snapshot.trees ? snapshot.trees[".protocol"] : snapshot;
            if (storage !== undefined) {
                [members, proposals, values] = await Promise.all([
                    readAndParse<[string, ISequencedClient][]>(storage, baseTree.blobs.quorumMembers),
                    readAndParse<[number, ISequencedProposal, string[]][]>(storage, baseTree.blobs.quorumProposals),
                    readAndParse<[string, ICommittedProposal][]>(storage, baseTree.blobs.quorumValues),
                ]);
            } else {
                members = readAndParseFromBlobs<[string, ISequencedClient][]>(snapshot.trees[".protocol"].blobs,
                    baseTree.blobs.quorumMembers);
                proposals = readAndParseFromBlobs<[number, ISequencedProposal, string[]][]>(
                    snapshot.trees[".protocol"].blobs, baseTree.blobs.quorumProposals);
                values = readAndParseFromBlobs<[string, ICommittedProposal][]>(snapshot.trees[".protocol"].blobs,
                    baseTree.blobs.quorumValues);
            }
        }

        const protocolHandler = this.initializeProtocolState(
            attributes,
            members,
            proposals,
            values);

        return protocolHandler;
    }

    private initializeProtocolState(
        attributes: IDocumentAttributes,
        members: [string, ISequencedClient][],
        proposals: [number, ISequencedProposal, string[]][],
        values: [string, any][],
    ): ProtocolOpHandler {
        const protocol = new ProtocolOpHandler(
            "", // branchId
            attributes.minimumSequenceNumber,
            attributes.sequenceNumber,
            undefined, // term
            members,
            proposals,
            values,
            (key, value) => this.submitMessage(MessageType.Propose, { key, value }),
            (sequenceNumber) => this.submitMessage(MessageType.Reject, sequenceNumber));

        // Track membership changes and update connection state accordingly
        protocol.quorum.on("addMember", (clientId, details) => {
            // This is the only one that requires the pending client ID
            if (clientId === this.pendingClientId) {
                this.setConnectionState(ConnectionState.Connected);
            }
        });

        return protocol;
    }

    private get client(): IClient {
        return {
            details: {
                capabilities: { interactive: true },
            },
            mode: "read", // default reconnection mode on lost connection / connection error
            permission: [],
            scopes: [],
            user: { id: "" },
        };
    }

    private createDeltaManager() {
        const deltaManager = new DeltaManager(
            () => this.service,
            this.client,
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

            // Check if we already processed our own join op through delta storage!
            // we are fetching ops from storage in parallel to connecting to ordering service
            // Given async processes, it's possible that we have already processed our own join message before
            // connection was fully established.
            // Note that we might be still initializing quorum - connection is established proactively on load!
            if ((this._protocolHandler !== undefined && this._protocolHandler.quorum.has(details.clientId))
                    || deltaManager.connectionMode === "read") {
                this.setConnectionState(ConnectionState.Connected);
            }
        });

        deltaManager.on("disconnect", (reason: string) => {
            this.setConnectionState(ConnectionState.Disconnected, reason);
        });

        return deltaManager;
    }

    private attachDeltaManagerOpHandler(attributes: IDocumentAttributes): void {
        // If we're the outer frame, do we want to do this?
        // Begin fetching any pending deltas once we know the base sequence #. Can this fail?
        // It seems like something, like reconnection, that we would want to retry but otherwise allow
        // the document to load
        this._deltaManager.attachOpHandler(
            attributes.minimumSequenceNumber,
            attributes.sequenceNumber,
            {
                process: (message) => this.processRemoteMessage(message),
                processSignal: (message) => {
                    this.processSignal(message);
                },
            });
    }

    private setConnectionState(value: ConnectionState.Disconnected, reason: string);
    private setConnectionState(value: ConnectionState.Connecting | ConnectionState.Connected);
    private setConnectionState(
        value: ConnectionState,
        reason?: string) {
        assert(value !== ConnectionState.Connecting);
        if (this.connectionState === value) {
            // Already in the desired state - exit early
            return;
        }

        this._connectionState = value;

        if (value === ConnectionState.Connected) {
            // Mark our old client should have left in the quorum if it's still there
            if (this._clientId !== undefined) {
                const client: ILocalSequencedClient | undefined =
                    this._protocolHandler?.quorum.getMember(this._clientId);
                if (client !== undefined) {
                    client.shouldHaveLeft = true;
                }
            }
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
        this.protocolHandler.quorum.setConnectionState(state, this.clientId);
        raiseConnectedEvent(this, state, this.clientId);
    }

    private submitContainerMessage(type: MessageType, contents: any, batch?: boolean, metadata?: any): number {
        const outboundMessageType: string = type;
        switch (outboundMessageType) {
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
        // Check and report if we're getting messages from a clientId that we previously
        // flagged as shouldHaveLeft, or from a client that's not in the quorum but should be
        if (message.clientId != null) {
            let errorMsg: string | undefined;
            const client: ILocalSequencedClient | undefined =
                this.protocolHandler.quorum.getMember(message.clientId);
            if (client === undefined && message.type !== MessageType.ClientJoin) {
                errorMsg = "messageClientIdMissingFromQuorum";
            } else if (client?.shouldHaveLeft === true) {
                errorMsg = "messageClientIdShouldHaveLeft";
            }
            if (errorMsg !== undefined) {
                const error = new GenericError(
                    errorMsg,
                    {
                        clientId: this._clientId,
                        messageClientId: message.clientId,
                        sequenceNumber: message.sequenceNumber,
                        clientSequenceNumber: message.clientSequenceNumber,
                    },
                );
                this.close(CreateContainerError(error));
            }
        }

        const local = this._clientId === message.clientId;

        // Forward non system messages to the loaded runtime for processing
        if (!isSystemMessage(message)) {
            try {
                this.context.process(message, local, undefined);
            } catch (e) {
                this.close(e);
            }
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
