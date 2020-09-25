/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { EventEmitter } from "events";
import {
    IFluidRouter,
    IFluidHandleContext,
    IFluidSerializer,
    IRequest,
    IResponse,
} from "@fluidframework/core-interfaces";
import {
    IRuntime,
    AttachState,
} from "@fluidframework/container-definitions";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import {
    Deferred,
} from "@fluidframework/common-utils";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    BlobCacheStorageService,
    buildSnapshotTree,
} from "@fluidframework/driver-utils";
import {
    ISequencedDocumentMessage,
    ISnapshotTree,
    MessageType,
} from "@fluidframework/protocol-definitions";
import {
    IAttachMessage,
    InboundAttachMessage,
    IFluidDataStoreRegistry,
    IFluidDataStoreChannel,
    IEnvelope,
    NamedFluidDataStoreRegistryEntries,
} from "@fluidframework/runtime-definitions";
import {
    FluidSerializer,
    RequestParser,
} from "@fluidframework/runtime-utils";
import { v4 as uuid } from "uuid";
import {
    FluidDataStoreContext,
    LocalFluidDataStoreContext,
    RemotedFluidDataStoreContext,
} from "./dataStoreContext";
import { ContainerFluidHandleContext } from "./containerHandleContext";
import { FluidDataStoreRegistry } from "./dataStoreRegistry";
import { PendingStateManager } from "./pendingStateManager";

export enum ContainerMessageType {
    // An op to be delivered to store
    FluidDataStoreOp = "component",

    // Creates a new store
    Attach = "attach",
}

export interface ContainerRuntimeMessage {
    contents: any;
    type: ContainerMessageType;
}

export function isRuntimeMessage(message: ISequencedDocumentMessage): boolean {
    switch (message.type) {
        case ContainerMessageType.FluidDataStoreOp:
        case ContainerMessageType.Attach:
        case MessageType.Operation:
            return true;
        default:
            return false;
    }
}

function unpackRuntimeMessage(message: ISequencedDocumentMessage) {
    if (message.type !== MessageType.Operation) {
        return message;
    }

    const unpackedMessage = { ...message };
    assert(message.contents.type !== undefined);
    unpackedMessage.type = message.contents.type;
    unpackedMessage.contents = message.contents.contents;
    assert(isRuntimeMessage(unpackedMessage));
    return unpackedMessage;
}

/**
 * Represents the runtime of the container. Contains helper functions/state of the container.
 * It will define the store level mappings.
 */
export class ContainerRuntime extends EventEmitter
    implements IContainerRuntime, IRuntime {
    public get IContainerRuntime() { return this; }
    public get IFluidRouter() { return this; }

    public get clientId(): string | undefined {
        throw new Error("Client ID not supported on ContainerRuntime right now");
    }

    public get IFluidDataStoreRegistry(): IFluidDataStoreRegistry {
        return this.registry;
    }

    public get attachState(): AttachState {
        return AttachState.Attached;
    }

    public readonly IFluidSerializer: IFluidSerializer = new FluidSerializer();

    public readonly IFluidHandleContext: IFluidHandleContext;

    private readonly notBoundContexts = new Set<string>();

    private _connected: boolean = true;

    public get connected(): boolean {
        return this._connected;
    }

    // Stores tracked by the Domain
    private readonly pendingAttach = new Map<string, IAttachMessage>();
    private readonly pendingStateManager: PendingStateManager;

    // Attached and loaded context proxies
    private readonly contexts = new Map<string, FluidDataStoreContext>();
    // List of pending contexts (for the case where a client knows a store will exist and is waiting
    // on its creation). This is a superset of contexts.
    private readonly contextsDeferred = new Map<string, Deferred<FluidDataStoreContext>>();
    private readonly registry: IFluidDataStoreRegistry;

    constructor(
        public readonly existing: boolean,
        private readonly submitFn: (contents: any) => number,
        private readonly storage: IDocumentStorageService,
        registryEntries: NamedFluidDataStoreRegistryEntries,
        private readonly requestHandler?: (request: IRequest, runtime: IContainerRuntime) => Promise<IResponse>,
    ) {
        super();

        this.registry = new FluidDataStoreRegistry(registryEntries);

        this.IFluidHandleContext = new ContainerFluidHandleContext("", this);

        this.pendingStateManager = new PendingStateManager();
    }

    /**
     * Notifies this object about the request made to the container.
     * @param request - Request made to the handler.
     */
    public async request(request: IRequest): Promise<IResponse> {
        if (this.requestHandler !== undefined) {
            return this.requestHandler(request, this);
        }

        return {
            status: 404,
            mimeType: "text/plain",
            value: "resource not found",
        };
    }

    /**
     * Resolves URI representing handle
     * @param request - Request made to the handler.
     */
    public async resolveHandle(request: IRequest): Promise<IResponse> {
        const requestParser = new RequestParser(request);

        if (requestParser.pathParts.length > 0) {
            const wait =
                typeof request.headers?.wait === "boolean" ? request.headers.wait : undefined;

            const dataStore = await this.getDataStore(requestParser.pathParts[0], wait);
            const subRequest = requestParser.createSubRequest(1);
            if (subRequest !== undefined) {
                return dataStore.IFluidRouter.request(subRequest);
            } else {
                return {
                    status: 200,
                    mimeType: "fluid/object",
                    value: dataStore,
                };
            }
        }

        return {
            status: 404,
            mimeType: "text/plain",
            value: "resource not found",
        };
    }

    // Call this after we see our own join message
    public setConnectionState(connected: boolean) {
        // There might be no change of state due to Container calling this API after loading runtime.
        this._connected = connected;

        for (const [, context] of this.contexts) {
            context.setConnectionState(connected);
        }
    }

    public process(message: ISequencedDocumentMessage, local: boolean) {
        // If it's not message for runtime, bail out right away.
        if (!isRuntimeMessage(message)) {
            return;
        }

        const unpackedMessage = unpackRuntimeMessage(message);

        let localMessageMetadata: unknown;
        if (local) {
            localMessageMetadata = this.pendingStateManager.processPendingLocalMessage(unpackedMessage);
        }

        switch (unpackedMessage.type) {
            case ContainerMessageType.Attach:
                this.processAttachMessage(unpackedMessage, local, localMessageMetadata);
                break;
            case ContainerMessageType.FluidDataStoreOp:
                this.processFluidDataStoreOp(unpackedMessage, local, localMessageMetadata);
                break;
            default:
        }

        this.emit("op", unpackedMessage);
    }

    public async getRootDataStore(id: string, wait = true): Promise<IFluidRouter> {
        return this.getDataStore(id, wait);
    }

    private async getDataStore(id: string, wait = true): Promise<IFluidRouter> {
        // Ensure deferred if it doesn't exist which will resolve once the process ID arrives
        const deferredContext = this.ensureContextDeferred(id);

        if (!wait && !deferredContext.isCompleted) {
            return Promise.reject(`Process ${id} does not exist`);
        }

        const context = await deferredContext.promise;
        return context.realize();
    }

    public async createDataStore(pkg: string | string[]): Promise<IFluidRouter> {
        return this._createDataStore(pkg);
    }

    public async createRootDataStore(pkg: string | string[], rootDataStoreId: string): Promise<IFluidRouter> {
        const fluidDataStore = await this._createDataStore(pkg, rootDataStoreId);
        fluidDataStore.bindToContext();
        return fluidDataStore;
    }

    private async _createDataStore(pkg: string | string[], id = uuid()): Promise<IFluidDataStoreChannel> {
        return this._createFluidDataStoreContext(Array.isArray(pkg) ? pkg : [pkg], id).realize();
    }

    private _createFluidDataStoreContext(pkg: string[], id) {
        const context = new LocalFluidDataStoreContext(
            id,
            pkg,
            this,
            this.storage,
            (cr: IFluidDataStoreChannel) => this.bindFluidDataStore(cr),
            undefined,
        );
        this.setupNewContext(context);
        return context;
    }

    private setupNewContext(context) {
        const id = context.id;
        assert(!this.contexts.has(id), "Creating store with existing ID");
        this.notBoundContexts.add(id);
        const deferred = new Deferred<FluidDataStoreContext>();
        this.contextsDeferred.set(id, deferred);
        this.contexts.set(id, context);
    }

    public on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    private processAttachMessage(message: ISequencedDocumentMessage, local: boolean, localMessageMetadata: unknown) {
        const attachMessage = message.contents as InboundAttachMessage;
        // The local object has already been attached
        if (local) {
            assert(this.pendingAttach.has(attachMessage.id));
            this.contexts.get(attachMessage.id)?.emit("attached");
            this.pendingAttach.delete(attachMessage.id);
            return;
        }

        const flatBlobs = new Map<string, string>();
        let flatBlobsP = Promise.resolve(flatBlobs);
        let snapshotTreeP: Promise<ISnapshotTree> | null = null;
        if (attachMessage.snapshot) {
            snapshotTreeP = buildSnapshotTree(attachMessage.snapshot.entries, flatBlobs);
            // flatBlobs' validity is contingent on snapshotTreeP's resolution
            flatBlobsP = snapshotTreeP.then((snapshotTree) => { return flatBlobs; });
        }

        // Include the type of attach message which is the pkg of the store to be
        // used by RemotedFluidDataStoreContext in case it is not in the snapshot.
        const pkg = [attachMessage.type];
        const remotedFluidDataStoreContext = new RemotedFluidDataStoreContext(
            attachMessage.id,
            snapshotTreeP,
            this,
            new BlobCacheStorageService(this.storage, flatBlobsP),
            pkg,
        );

        // If a non-local operation then go and create the object, otherwise mark it as officially attached.
        assert(!this.contexts.has(attachMessage.id), "Store attached with existing ID");

        // Resolve pending gets and store off any new ones
        this.setNewContext(attachMessage.id, remotedFluidDataStoreContext);

        // Equivalent of nextTick() - Prefetch once all current ops have completed
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        Promise.resolve().then(async () => remotedFluidDataStoreContext.realize());
    }

    private processFluidDataStoreOp(message: ISequencedDocumentMessage, local: boolean, localMessageMetadata: unknown) {
        const envelope = message.contents as IEnvelope;
        const transformed = { ...message, contents: envelope.contents };
        const context = this.getContext(envelope.address);
        context.process(transformed, local, localMessageMetadata);
    }

    private bindFluidDataStore(fluidDataStoreRuntime: IFluidDataStoreChannel): void {
        assert(this.notBoundContexts.has(fluidDataStoreRuntime.id),
            "Store to be bound should be in not bounded set");
        this.notBoundContexts.delete(fluidDataStoreRuntime.id);
        const context = this.getContext(fluidDataStoreRuntime.id) as LocalFluidDataStoreContext;
        // If the container is detached, we don't need to send OP or add to pending attach because
        // we will summarize it while uploading the create new summary and make it known to other
        // clients.
        if (this.attachState !== AttachState.Detached) {
            context.emit("attaching");
            const message = context.generateAttachMessage();

            this.pendingAttach.set(fluidDataStoreRuntime.id, message);
            this.submit(ContainerMessageType.Attach, message);
        }

        // Resolve the deferred so other local stores can access it.
        const deferred = this.getContextDeferred(fluidDataStoreRuntime.id);
        deferred.resolve(context);
    }

    private ensureContextDeferred(id: string): Deferred<FluidDataStoreContext> {
        const deferred = this.contextsDeferred.get(id);
        if (deferred) { return deferred; }
        const newDeferred = new Deferred<FluidDataStoreContext>();
        this.contextsDeferred.set(id, newDeferred);
        return newDeferred;
    }

    private getContextDeferred(id: string): Deferred<FluidDataStoreContext> {
        const deferred = this.contextsDeferred.get(id);
        assert(deferred !== undefined);
        return deferred;
    }

    private setNewContext(id: string, context?: FluidDataStoreContext) {
        assert(context);
        assert(!this.contexts.has(id));
        this.contexts.set(id, context);
        const deferred = this.ensureContextDeferred(id);
        deferred.resolve(context);
    }

    private getContext(id: string): FluidDataStoreContext {
        const context = this.contexts.get(id);
        assert(context !== undefined, `Didn't find context: ${id}`);
        return context;
    }

    public setAttachState(attachState: AttachState.Attaching | AttachState.Attached): void {
        let eventName: string;
        if (attachState === AttachState.Attaching) {
            assert(this.attachState === AttachState.Attaching,
                "Container Context should already be in attaching state");
            eventName = "attaching";
        } else {
            assert(this.attachState === AttachState.Attached, "Container Context should already be in attached state");
            eventName = "attached";
        }
        for (const context of this.contexts.values()) {
            // Fire only for bounded stores.
            if (!this.notBoundContexts.has(context.id)) {
                context.emit(eventName);
            }
        }
    }

    public submitDataStoreOp(
        id: string,
        contents: any,
        localOpMetadata: unknown = undefined): void {
        const envelope: IEnvelope = {
            address: id,
            contents,
        };
        this.submit(ContainerMessageType.FluidDataStoreOp, envelope, localOpMetadata);
    }

    private submit(
        type: ContainerMessageType,
        content: any,
        localOpMetadata: unknown = undefined,
    ): void {
        const payload: ContainerRuntimeMessage = { type, contents: content };
        const clientSequenceNumber = this.submitFn(payload);

        // Let the PendingStateManager know that a message was submitted.
        this.pendingStateManager.onSubmitMessage(type, clientSequenceNumber, content, localOpMetadata);
    }
}
