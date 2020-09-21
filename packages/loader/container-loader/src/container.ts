/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { IRequest, IResponse, IFluidRouter } from "@fluidframework/core-interfaces";
import {
    IConnectionDetails,
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
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
    ISequencedDocumentMessage,
    ISequencedDocumentSystemMessage,
    ISignalMessage,
    MessageType,
} from "@fluidframework/protocol-definitions";

import { ContainerContext } from "./containerContext";
import { IConnectionArgs, DeltaManager } from "./deltaManager";

export class Container implements IFluidRouter {
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
    private _connected: boolean = false;

    private _context: ContainerContext | undefined;
    private get context() {
        if (this._context === undefined) {
            throw new Error("Attempted to access context before it was defined");
        }
        return this._context;
    }

    private resumedOpProcessingAfterLoad = false;

    public get IFluidRouter(): IFluidRouter { return this; }

    public get id(): string {
        return this._documentId ?? "";
    }

    public get connected(): boolean {
        return this._connected;
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

    constructor(
        private readonly containerRuntimeFactory: IRuntimeFactory,
        private readonly deltaService: IDocumentDeltaService,
        private readonly deltaStorageService: IDocumentDeltaStorageService,
        private readonly storageService: IDocumentStorageService,
        documentId: string,
    ) {
        this._documentId = documentId;

        this._deltaManager = this.createDeltaManager();
    }

    public async request(path: IRequest): Promise<IResponse> {
        return this.context.request(path);
    }

    private resumeInternal(args: IConnectionArgs = {}) {
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
        if (!this.client.details.capabilities.interactive) {
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

        this.resumeInternal();

        // Internal context is fully loaded at this point
        this.loaded = true;
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
        );

        deltaManager.on("connect", (details: IConnectionDetails, opsBehind?: number) => {
            // Stash the clientID to detect when transitioning from connecting (socket.io channel open) to connected
            // (have received the join message for the client ID)
            // This is especially important in the reconnect case. It's possible there could be outstanding
            // ops sent by this client, so we should keep the old client id until we see our own client's
            // join message. after we see the join message for out new connection with our new client id,
            // we know there can no longer be outstanding ops that we sent with the previous client id.
            this.pendingClientId = details.clientId;

            if (deltaManager.connectionMode === "read") {
                this.setConnected(true);
            }
        });

        deltaManager.on("disconnect", () => {
            this.setConnected(false);
        });

        return deltaManager;
    }

    private setConnected(value: boolean) {
        if (this._connected === value) {
            // Already in the desired state - exit early
            return;
        }

        this._connected = value;

        if (value) {
            this._clientId = this.pendingClientId;
            this._deltaManager.setConnected();
        } else {
            // Important as we process our own joinSession message through delta request
            this.pendingClientId = undefined;
        }

        if (this.loaded) {
            this.propagateConnectionState();
        }
    }

    private propagateConnectionState() {
        const state = this._connected;
        this.context.setConnectionState(state, this.clientId);
    }

    private submitContainerMessage(type: MessageType, contents: any): number {
        if (type !== MessageType.Operation) {
            throw new Error(`Runtime can't send arbitrary message type: ${type}`);
        }

        return this.submitMessage(type, contents);
    }

    private submitMessage(type: MessageType, contents: any): number {
        if (!this._connected) {
            return -1;
        }

        return this._deltaManager.submit(type, contents);
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
                this.setConnected(true);
            }
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

    private async loadContext() {
        this._context = await ContainerContext.createOrLoad(
            this,
            this.containerRuntimeFactory,
            (type, contents) => this.submitContainerMessage(type, contents),
            (message) => this.submitSignal(message),
        );
    }
}
