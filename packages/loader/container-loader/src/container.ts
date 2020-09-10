/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { EventEmitter } from "events";
// eslint-disable-next-line import/no-internal-modules
import merge from "lodash/merge";
import { IRequest, IResponse, IFluidRouter } from "@fluidframework/core-interfaces";
import {
    IAudience,
    ICodeLoader,
    IConnectionDetails,
    IContainer,
    IContainerEvents,
    IDeltaManager,
    IFluidCodeDetails,
    IGenericBlob,
    ILoader,
    IRuntimeFactory,
    LoaderHeader,
    AttachState,
} from "@fluidframework/container-definitions";
import {
    EventEmitterWithErrorHandling,
} from "@fluidframework/telemetry-utils";
import {
    IDocumentService,
    IDocumentStorageService,
    IFluidResolvedUrl,
    IUrlResolver,
    IDocumentServiceFactory,
    IResolvedUrl,
    CreateNewHeader,
} from "@fluidframework/driver-definitions";
import {
    readAndParse,
    ensureFluidResolvedUrl,
    combineAppAndProtocolSummary,
} from "@fluidframework/driver-utils";
import {
    isSystemMessage,
    ProtocolOpHandler,
    QuorumProxy,
} from "@fluidframework/protocol-base";
import {
    FileMode,
    IClient,
    IClientDetails,
    ICommittedProposal,
    IDocumentAttributes,
    IDocumentMessage,
    IProcessMessageResult,
    IQuorum,
    ISequencedClient,
    ISequencedDocumentMessage,
    ISequencedProposal,
    IServiceConfiguration,
    ISignalClient,
    ISignalMessage,
    ISnapshotTree,
    ITree,
    ITreeEntry,
    IVersion,
    MessageType,
    TreeEntry,
    ISummaryTree,
} from "@fluidframework/protocol-definitions";
import { Audience } from "./audience";
import { BlobManager } from "./blobManager";
import { ContainerContext } from "./containerContext";
import { IConnectionArgs, DeltaManager } from "./deltaManager";
import { DeltaManagerProxy } from "./deltaManagerProxy";
import { NullChaincode } from "./nullRuntime";
import { PrefetchDocumentStorageService } from "./prefetchDocumentStorageService";
import { parseUrl, convertProtocolAndAppSummaryToSnapshotTree } from "./utils";

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

class LocalLoader extends EventEmitter implements ILoader {
    /**
     * BaseRequest is the original request that triggered the load. This URL is used in case credentials need
     * to be fetched again.
     */
    constructor(
        private readonly container: Container,
    ) {
        super();
    }

    public async resolve(request: IRequest): Promise<IContainer> {
        if (request.url.startsWith("/")) {
            return this.container;
        }

        throw new Error("Resolved non-container-relative url");
    }

    public async request(request: IRequest): Promise<IResponse> {
        if (request.url.startsWith("/")) {
            return this.container.request(request);
        }

        throw new Error("Requested non-container-relative url");
    }

    public async createDetachedContainer(source: IFluidCodeDetails): Promise<Container> {
        throw new Error("Local loader should not create a detached container");
    }
}

export class Container extends EventEmitterWithErrorHandling<IContainerEvents> implements IContainer {
    /**
     * Load container.
     */
    public static async load(
        documentId: string,
        serviceFactory: IDocumentServiceFactory,
        codeLoader: ICodeLoader,
        request: IRequest,
        resolvedUrl: IFluidResolvedUrl,
        urlResolver: IUrlResolver,
    ): Promise<Container> {
        const container = new Container(
            codeLoader,
            serviceFactory,
            urlResolver,
            resolvedUrl,
            !(request.headers?.[LoaderHeader.reconnect] === false),
            request,
            decodeURI(documentId),
        );
        const version = request.headers?.[LoaderHeader.version];
        await container.load(version);
        return container;
    }

    public static async create(
        codeLoader: ICodeLoader,
        source: IFluidCodeDetails,
        serviceFactory: IDocumentServiceFactory,
        urlResolver: IUrlResolver,
    ): Promise<Container> {
        const container = new Container(
            codeLoader,
            serviceFactory,
            urlResolver,
        );
        await container.createDetached(source);

        return container;
    }

    private pendingClientId: string | undefined;
    private loaded = false;
    private _attachState = AttachState.Detached;
    private blobManager: BlobManager | undefined;

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
    private _loadedFromVersion: IVersion | undefined;
    private cachedAttachSummary: ISummaryTree | undefined;
    private attachInProgress = false;

    public get IFluidRouter(): IFluidRouter { return this; }

    public get resolvedUrl(): IResolvedUrl | undefined {
        return this._resolvedUrl;
    }

    public get loadedFromVersion(): IVersion | undefined {
        return this._loadedFromVersion;
    }

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
        return this._canReconnect;
    }

    /**
     * Service configuration details. If running in offline mode will be undefined otherwise will contain service
     * configuration details returned as part of the initial connection.
     */
    public get serviceConfiguration(): IServiceConfiguration | undefined {
        return this._deltaManager.serviceConfiguration;
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

    public get clientDetails(): IClientDetails {
        return this._deltaManager.clientDetails;
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
        private readonly codeLoader: ICodeLoader,
        private readonly serviceFactory: IDocumentServiceFactory,
        private readonly urlResolver: IUrlResolver,
        private _resolvedUrl?: IResolvedUrl | undefined,
        private _canReconnect: boolean = true,
        private originalRequest?: IRequest | undefined,
        private _documentId?: string | undefined,
    ) {
        super();
        this._audience = new Audience();

        this._deltaManager = this.createDeltaManager();
    }

    /**
     * Retrieves the quorum associated with the document
     */
    public getQuorum(): IQuorum {
        return this.protocolHandler.quorum;
    }

    public get attachState(): AttachState {
        return this._attachState;
    }

    public serialize(): string {
        assert.strictEqual(this.attachState, AttachState.Detached, "Should only be called in detached container");

        const appSummary: ISummaryTree = this.context.createSummary();
        const protocolSummary = this.protocolHandler.captureSummary();
        const snapshotTree = convertProtocolAndAppSummaryToSnapshotTree(protocolSummary, appSummary);
        return JSON.stringify(snapshotTree);
    }

    public async attach(request: IRequest): Promise<void> {
        // If container is already attached or attach is in progress, return.
        if (this._attachState === AttachState.Attached || this.attachInProgress) {
            return;
        }
        this.attachInProgress = true;
        try {
            assert.strictEqual(this.deltaManager.inbound.length, 0, "Inbound queue should be empty when attaching");
            // Only take a summary if the container is in detached state, otherwise we could have local changes.
            // In failed attach call, we would already have a summary cached.
            if (this._attachState === AttachState.Detached) {
                // Get the document state post attach - possibly can just call attach but we need to change the
                // semantics around what the attach means as far as async code goes.
                const appSummary: ISummaryTree = this.context.createSummary();
                if (this.protocolHandler === undefined) {
                    throw new Error("Protocol Handler is undefined");
                }
                const protocolSummary = this.protocolHandler.captureSummary();
                this.cachedAttachSummary = combineAppAndProtocolSummary(appSummary, protocolSummary);

                // Set the state as attaching as we are starting the process of attaching container.
                // This should be fired after taking the summary because it is the place where we are
                // starting to attach the container to storage.
                // Also, this should only be fired in detached container.
                this._attachState = AttachState.Attaching;
                this.emit("attaching");
            }
            assert(this.cachedAttachSummary,
                "Summary should be there either by this attach call or previous attach call!!");

            if (request.headers?.[CreateNewHeader.createNew] === undefined) {
                request.headers = {
                    ...request.headers,
                    [CreateNewHeader.createNew]: {},
                };
            }

            const createNewResolvedUrl = await this.urlResolver.resolve(request);
            ensureFluidResolvedUrl(createNewResolvedUrl);
            // Actually go and create the resolved document
            if (this.service === undefined) {
                await this.serviceFactory.submitContainer(
                    this.cachedAttachSummary,
                    createNewResolvedUrl,
                );
                this.service = await this.serviceFactory.createDocumentService(createNewResolvedUrl);
            }
            ensureFluidResolvedUrl(createNewResolvedUrl);
            this._resolvedUrl = createNewResolvedUrl;
            const url = await this.getAbsoluteUrl("");
            assert(url !== undefined, "Container url undefined");
            this.originalRequest = { url };
            this._canReconnect = !(request.headers?.[LoaderHeader.reconnect] === false);
            const parsedUrl = parseUrl(createNewResolvedUrl.url);
            if (parsedUrl === undefined) {
                throw new Error("Unable to parse Url");
            }
            const [, docId] = parsedUrl.id.split("/");
            this._documentId = decodeURI(docId);

            if (this._storageService === undefined) {
                this._storageService = await this.getDocumentStorageService();
            }

            // This we can probably just pass the storage service to the blob manager - although ideally
            // there just isn't a blob manager
            if (this.blobManager === undefined) {
                this.blobManager = await this.loadBlobManager(this.storageService, undefined);
            }
            this._attachState = AttachState.Attached;
            this.emit("attached");
            this.cachedAttachSummary = undefined;
            // We know this is create new flow.
            this._existing = false;

            // Propagate current connection state through the system.
            const connected = this.connectionState === ConnectionState.Connected;
            assert(!connected || this._deltaManager.connectionMode === "read", "Unexpected connection state");
            this.propagateConnectionState();
            this.resumeInternal({ fetchOpsFromStorage: false, mode: "write" });
        } finally {
            this.attachInProgress = false;
        }
    }

    public async request(path: IRequest): Promise<IResponse> {
        return this.context.request(path);
    }

    public async snapshot(tagMessage: string, fullTree: boolean = false): Promise<void> {
        // Only snapshot once a code quorum has been established
        if (!this.protocolHandler.quorum.has("code")) {
            return;
        }

        // Stop inbound message processing while we complete the snapshot
        try {
            if (this.deltaManager !== undefined) {
                await this.deltaManager.inbound.systemPause();
            }

            await this.snapshotCore(tagMessage, fullTree);
        } finally {
            if (this.deltaManager !== undefined) {
                this.deltaManager.inbound.systemResume();
            }
        }
    }

    public setAutoReconnect(reconnect: boolean) {
        assert(this.resumedOpProcessingAfterLoad);

        this._deltaManager.setAutomaticReconnect(reconnect);

        if (reconnect) {
            // Ensure connection to web socket
            this.connectToDeltaStream().catch((error) => { });
        }
    }

    public resume() {
        this.resumeInternal();
    }

    private resumeInternal(args: IConnectionArgs = {}) {
        assert(this.loaded);

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

    public get storage(): IDocumentStorageService | undefined {
        return this._storageService;
    }

    public hasNullRuntime() {
        return this.context.hasNullRuntime();
    }

    private async getAbsoluteUrl(relativeUrl: string): Promise<string | undefined> {
        if (this.resolvedUrl === undefined) {
            return undefined;
        }

        // TODO: Remove support for legacy requestUrl in 0.20
        const legacyResolver = this.urlResolver as {
            requestUrl?(resolvedUrl: IResolvedUrl, request: IRequest): Promise<IResponse>;

            getAbsoluteUrl?(
                resolvedUrl: IResolvedUrl,
                relativeUrl: string,
            ): Promise<string>;
        };

        if (legacyResolver.getAbsoluteUrl !== undefined) {
            return this.urlResolver.getAbsoluteUrl(
                this.resolvedUrl,
                relativeUrl);
        }

        if (legacyResolver.requestUrl !== undefined) {
            const response = await legacyResolver.requestUrl(
                this.resolvedUrl,
                { url: relativeUrl });

            if (response.status === 200) {
                return response.value as string;
            }
            throw new Error(response.value);
        }

        throw new Error("Url Resolver does not support creating urls");
    }

    private async snapshotCore(tagMessage: string, fullTree: boolean = false) {
        // Snapshots base document state and currently running context
        const root = this.snapshotBase();
        const dataStoreEntries = await this.context.snapshot(tagMessage, fullTree);

        // And then combine
        if (dataStoreEntries !== null) {
            root.entries.push(...dataStoreEntries.entries);
        }

        // Generate base snapshot message
        const deltaDetails =
            `${this._deltaManager.lastSequenceNumber}:${this._deltaManager.minimumSequenceNumber}`;
        const message = `Commit @${deltaDetails} ${tagMessage}`;

        // Pull in the prior version and snapshot tree to store against
        const lastVersion = await this.getVersion(this.id);

        const parents = lastVersion !== undefined ? [lastVersion.id] : [];

        // Write the full snapshot
        return this.storageService.write(root, parents, message, "");
    }

    private snapshotBase(): ITree {
        const entries: ITreeEntry[] = [];

        if (this.blobManager === undefined) {
            throw new Error("Attempted to snapshot without a blobManager");
        }

        const blobMetaData = this.blobManager.getBlobMetadata();
        entries.push({
            mode: FileMode.File,
            path: ".blobs",
            type: TreeEntry.Blob,
            value: {
                contents: JSON.stringify(blobMetaData),
                encoding: "utf-8",
            },
        });

        const quorumSnapshot = this.protocolHandler.quorum.snapshot();
        entries.push({
            mode: FileMode.File,
            path: "quorumMembers",
            type: TreeEntry.Blob,
            value: {
                contents: JSON.stringify(quorumSnapshot.members),
                encoding: "utf-8",
            },
        });
        entries.push({
            mode: FileMode.File,
            path: "quorumProposals",
            type: TreeEntry.Blob,
            value: {
                contents: JSON.stringify(quorumSnapshot.proposals),
                encoding: "utf-8",
            },
        });
        entries.push({
            mode: FileMode.File,
            path: "quorumValues",
            type: TreeEntry.Blob,
            value: {
                contents: JSON.stringify(quorumSnapshot.values),
                encoding: "utf-8",
            },
        });

        // Save attributes for the document
        const documentAttributes = {
            minimumSequenceNumber: this._deltaManager.minimumSequenceNumber,
            sequenceNumber: this._deltaManager.lastSequenceNumber,
        };
        entries.push({
            mode: FileMode.File,
            path: ".attributes",
            type: TreeEntry.Blob,
            value: {
                contents: JSON.stringify(documentAttributes),
                encoding: "utf-8",
            },
        });

        // Output the tree
        const root: ITree = {
            entries,
            id: null,
        };

        return root;
    }

    private async getVersion(version: string): Promise<IVersion | undefined> {
        const versions = await this.storageService.getVersions(version, 1);
        return versions[0];
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
     */
    private async load(specifiedVersion: string | null | undefined) {
        if (this._resolvedUrl === undefined) {
            throw new Error("Attempting to load without a resolved url");
        }
        this.service = await this.serviceFactory.createDocumentService(this._resolvedUrl, undefined);

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
        startConnectionP.catch((error) => { });

        this._storageService = await this.getDocumentStorageService();
        this._attachState = AttachState.Attached;

        // Fetch specified snapshot, but intentionally do not load from snapshot if specifiedVersion is null
        const maybeSnapshotTree = specifiedVersion === null ? undefined
            : await this.fetchSnapshotTree(specifiedVersion);

        // We want to start this process early, but we don't need the blob manager just yet so we don't await.
        const blobManagerP = this.loadBlobManager(this.storageService, maybeSnapshotTree);

        const attributes = await this.getDocumentAttributes(this.storageService, maybeSnapshotTree);

        // Attach op handlers to start processing ops
        this.attachDeltaManagerOpHandler(attributes);

        // Initialize the protocol handler (quorum, etc.)
        // It's ok to await here because all of our promises are already kicked off and we need the
        // protocol handler before we can loadContext.
        this._protocolHandler =
            await this.loadAndInitializeProtocolState(attributes, this.storageService, maybeSnapshotTree);

        if (maybeSnapshotTree === undefined) {
            // It's ok to await here because all of our promises are already kicked off and
            // loadContext can't instantiateRuntime without knowing existing state.
            this._existing = await startConnectionP.then((details) => details.existing);
        } else {
            // If we have a snapshot, it must already exist.
            this._existing = true;
        }

        // We must await here because loadContext requires the blobManager.
        this.blobManager = await blobManagerP;

        await this.loadContext(maybeSnapshotTree);

        // Internal context is fully loaded at this point
        this.loaded = true;

        // Propagate current connection state through the system.
        this.propagateConnectionState();

        this.resume();

        return {
            existing: this._existing,
            sequenceNumber: attributes.sequenceNumber,
            version: maybeSnapshotTree?.id ?? undefined,
        };
    }

    private async createDetached(source: IFluidCodeDetails) {
        const attributes: IDocumentAttributes = {
            branch: "", // not used
            sequenceNumber: 0,
            term: 0, // not used
            minimumSequenceNumber: 0,
        };

        // Seed the base quorum to be an empty list with a code quorum set
        const committedCodeProposal: ICommittedProposal = {
            key: "code",
            value: source,
            approvalSequenceNumber: 0,
            commitSequenceNumber: 0,
            sequenceNumber: 0,
        };

        const members: [string, ISequencedClient][] = [];
        const proposals: [number, ISequencedProposal, string[]][] = [];
        const values: [string, ICommittedProposal][] = [["code", committedCodeProposal]];

        this.attachDeltaManagerOpHandler(attributes);

        // Need to just seed the source data in the code quorum. Quorum itself is empty
        this._protocolHandler = this.initializeProtocolState(
            attributes,
            members,
            proposals,
            values);

        // The load context - given we seeded the quorum - will be great
        await this.createDetachedContext();

        this.loaded = true;

        this.propagateConnectionState();
    }

    private async getDocumentStorageService(): Promise<IDocumentStorageService> {
        if (this.service === undefined) {
            throw new Error("Not attached");
        }
        const storageService = await this.service.connectToStorage();
        return new PrefetchDocumentStorageService(storageService);
    }

    private async getDocumentAttributes(
        storage: IDocumentStorageService,
        tree: ISnapshotTree | undefined,
    ): Promise<IDocumentAttributes> {
        if (tree === undefined) {
            return {
                branch: "", // not used
                minimumSequenceNumber: 0,
                sequenceNumber: 0,
                term: 0, // not used
            };
        }

        const attributesHash = tree.trees[".protocol"].blobs.attributes;
        const attributes = await readAndParse<IDocumentAttributes>(storage, attributesHash);

        return attributes;
    }

    private async loadAndInitializeProtocolState(
        attributes: IDocumentAttributes,
        storage: IDocumentStorageService,
        snapshot: ISnapshotTree | undefined,
    ): Promise<ProtocolOpHandler> {
        let members: [string, ISequencedClient][] = [];
        let proposals: [number, ISequencedProposal, string[]][] = [];
        let values: [string, any][] = [];

        if (snapshot !== undefined) {
            const baseTree = ".protocol" in snapshot.trees ? snapshot.trees[".protocol"] : snapshot;
            [members, proposals, values] = await Promise.all([
                readAndParse<[string, ISequencedClient][]>(storage, baseTree.blobs.quorumMembers),
                readAndParse<[number, ISequencedProposal, string[]][]>(storage, baseTree.blobs.quorumProposals),
                readAndParse<[string, ICommittedProposal][]>(storage, baseTree.blobs.quorumValues),
            ]);
        }

        return this.initializeProtocolState(
            attributes,
            members,
            proposals,
            values,
        );
    }

    private initializeProtocolState(
        attributes: IDocumentAttributes,
        members: [string, ISequencedClient][],
        proposals: [number, ISequencedProposal, string[]][],
        values: [string, any][],
    ): ProtocolOpHandler {
        const protocol = new ProtocolOpHandler(
            "", // branchId, not used
            attributes.minimumSequenceNumber,
            attributes.sequenceNumber,
            0, // term, not used
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

        protocol.quorum.on("removeMember", (clientId) => {
            if (clientId === this._clientId) {
                this._deltaManager.updateQuorumLeave();
            }
        });

        return protocol;
    }

    private async loadBlobManager(
        storage: IDocumentStorageService,
        tree: ISnapshotTree | undefined,
    ): Promise<BlobManager> {
        const blobHash = tree?.blobs[".blobs"];
        const blobs: IGenericBlob[] = blobHash !== undefined
            ? await readAndParse<IGenericBlob[]>(storage, blobHash)
            : [];

        const blobManager = new BlobManager(storage);
        blobManager.loadBlobMetadata(blobs);

        return blobManager;
    }

    private getCodeDetailsFromQuorum(): IFluidCodeDetails | undefined {
        return this.protocolHandler.quorum.get("code");
    }

    /**
     * Loads the runtime factory for the provided package
     */
    private async loadRuntimeFactory(pkg: IFluidCodeDetails): Promise<IRuntimeFactory> {
        const fluidModule = await this.codeLoader.load(pkg);

        const factory = fluidModule.fluidExport.IRuntimeFactory;
        if (factory === undefined) {
            throw new Error("Code package does not implement IRuntimeFactory");
        }
        return factory;
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

        // Client info from headers overrides client info from loader options
        const headerClientDetails = this.originalRequest?.headers?.[LoaderHeader.clientDetails];

        if (headerClientDetails !== undefined) {
            merge(client.details, headerClientDetails);
        }

        return client;
    }

    private createDeltaManager() {
        const deltaManager = new DeltaManager(
            () => this.service,
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
                this.setConnectionState(ConnectionState.Connected);
            }

            // Back-compat for new client and old server.
            this._audience.clear();

            for (const priorClient of details.initialClients ?? []) {
                this._audience.addMember(priorClient.clientId, priorClient.client);
            }
        });

        deltaManager.on("disconnect", () => {
            this.setConnectionState(ConnectionState.Disconnected);
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

    private setConnectionState(value: ConnectionState) {
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
        assert(this.loaded);

        const connected = this._connectionState === ConnectionState.Connected;
        this.context.setConnectionState(connected, this.clientId);
        this.protocolHandler.quorum.setConnectionState(connected, this.clientId);
    }

    private submitContainerMessage(type: MessageType, contents: any, batch?: boolean, metadata?: any): number {
        switch (type) {
            case MessageType.Operation:
            case MessageType.RemoteHelp:
            case MessageType.Summarize:
                break;
            default:
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

    /**
     * Get the most recent snapshot, or a specific version.
     * @param specifiedVersion - The specific version of the snapshot to retrieve
     * @returns The snapshot requested, or the latest snapshot if no version was specified
     */
    private async fetchSnapshotTree(specifiedVersion?: string): Promise<ISnapshotTree | undefined> {
        const version = await this.getVersion(specifiedVersion ?? this.id);

        if (version !== undefined) {
            this._loadedFromVersion = version;
            return await this.storageService.getSnapshotTree(version) ?? undefined;
        }

        return undefined;
    }

    private async loadContext(snapshot?: ISnapshotTree) {
        const codeDetails = this.getCodeDetailsFromQuorum();
        const runtimeFactory = codeDetails !== undefined
            ? await this.loadRuntimeFactory(codeDetails)
            : new NullChaincode();

        // The relative loader will proxy requests to '/' to the loader itself assuming no non-cache flags
        // are set. Global requests will still go to this loader
        const loader = new LocalLoader(this);

        this._context = await ContainerContext.createOrLoad(
            this,
            runtimeFactory,
            snapshot ?? null,
            this.blobManager,
            new DeltaManagerProxy(this._deltaManager),
            new QuorumProxy(this.protocolHandler.quorum),
            loader,
            (type, contents, batch, metadata) => this.submitContainerMessage(type, contents, batch, metadata),
            (message) => this.submitSignal(message),
            async (message) => this.snapshot(message),
        );

        this.emit("contextChanged", codeDetails);
    }

    /**
     * Creates a new, unattached container context
     */
    private async createDetachedContext() {
        const codeDetails = this.getCodeDetailsFromQuorum();
        if (codeDetails === undefined) {
            throw new Error("pkg should be provided in create flow!!");
        }
        const runtimeFactory = await this.loadRuntimeFactory(codeDetails);

        // The relative loader will proxy requests to '/' to the loader itself assuming no non-cache flags
        // are set. Global requests will still go to this loader
        const loader = new LocalLoader(this);

        this._context = await ContainerContext.createOrLoad(
            this,
            runtimeFactory,
            { id: null, blobs: {}, commits: {}, trees: {} },    // TODO this will be from the offline store
            this.blobManager,
            new DeltaManagerProxy(this._deltaManager),
            new QuorumProxy(this.protocolHandler.quorum),
            loader,
            (type, contents, batch, metadata) => this.submitContainerMessage(type, contents, batch, metadata),
            (message) => this.submitSignal(message),
            async (message) => this.snapshot(message),
        );

        this.emit("contextChanged", codeDetails);
    }
}
