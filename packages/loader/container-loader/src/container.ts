/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

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
    IClientJoin,
    ISequencedDocumentMessage,
    ISequencedDocumentSystemMessage,
    MessageType,
} from "@fluidframework/protocol-definitions";

import { ContainerContext } from "./containerContext";
import { DeltaManager } from "./deltaManager";

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

    public get storage(): IDocumentStorageService {
        return this.storageService;
    }

    /**
     * Load container.
     */
    private async load() {
        // Start websocket connection as soon as possible. Note that there is no op handler attached yet, but the
        // DeltaManager is resilient to this and will wait to start processing ops until after it is attached.
        const startConnectionP = this._deltaManager.connect();

        // Attach op handlers to start processing ops
        this._deltaManager.attachOpHandler({
            process: (message) => this.processRemoteMessage(message),
        });
        this._existing = await startConnectionP.then((details) => details.existing);

        await this.loadContext();

        // Propagate current connection state through the system.
        this.propagateConnectionState();

        // The queues start paused
        this._deltaManager.resume();

        // Internal context is fully loaded at this point
        this.loaded = true;
    }

    private createDeltaManager() {
        const deltaManager = new DeltaManager(
            this.deltaService,
            this.deltaStorageService,
        );

        deltaManager.on("connect", (details: IConnectionDetails) => {
            // Stash the clientID to detect when transitioning from connecting (socket.io channel open) to connected
            // (have received the join message for the client ID)
            // This is especially important in the reconnect case. It's possible there could be outstanding
            // ops sent by this client, so we should keep the old client id until we see our own client's
            // join message. after we see the join message for out new connection with our new client id,
            // we know there can no longer be outstanding ops that we sent with the previous client id.
            this.pendingClientId = details.clientId;
        });

        return deltaManager;
    }

    private setConnected() {
        if (this._connected) {
            // Already in the desired state - exit early
            return;
        }

        this._connected = true;
        this._clientId = this.pendingClientId;

        if (this.loaded) {
            this.propagateConnectionState();
        }
    }

    private propagateConnectionState() {
        const state = this._connected;
        this.context.setConnectionState(state, this.clientId);
    }

    private submitMessage(contents: any): number {
        if (!this._connected) {
            return -1;
        }

        return this._deltaManager.submit(MessageType.Operation, contents);
    }

    private processRemoteMessage(message: ISequencedDocumentMessage): void {
        const local = this._clientId === message.clientId;

        // Forward non system messages to the loaded runtime for processing
        if (!isSystemMessage(message)) {
            this.context.process(message, local);
        }

        // Leftover from quorum's addMember
        // Maybe push down into the socket driver?
        if (message.type === MessageType.ClientJoin) {
            const joinMessage = message as ISequencedDocumentSystemMessage;
            const join = JSON.parse(joinMessage.data) as IClientJoin;
            if (join.clientId === this.pendingClientId) {
                this.setConnected();
            }
        }
    }

    private async loadContext() {
        this._context = await ContainerContext.createOrLoad(
            this,
            this.containerRuntimeFactory,
            (contents) => this.submitMessage(contents),
        );
    }
}
