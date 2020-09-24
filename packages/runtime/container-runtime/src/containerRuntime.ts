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
    IContainerContext,
    IRuntime,
    AttachState,
} from "@fluidframework/container-definitions";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import {
    Deferred,
} from "@fluidframework/common-utils";
import {
    raiseConnectedEvent,
} from "@fluidframework/telemetry-utils";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    BlobCacheStorageService,
    buildSnapshotTree,
} from "@fluidframework/driver-utils";
import {
    ConnectionState,
    ISequencedDocumentMessage,
    ISnapshotTree,
    MessageType,
} from "@fluidframework/protocol-definitions";
import {
    IAttachMessage,
    InboundAttachMessage,
    IFluidDataStoreContextDetached,
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
    LocalDetachedFluidDataStoreContext,
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

    public get id(): string {
        return this.context.id;
    }

    public get existing(): boolean {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return this.context.existing!;
    }

    public get clientId(): string | undefined {
        return this.context.clientId;
    }

    private get storage(): IDocumentStorageService {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return this.context.storage!;
    }

    public get reSubmitFn(): (type: ContainerMessageType, content: any, localOpMetadata: unknown) => void {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        return this.reSubmit;
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
    // 0.24 back-compat attachingBeforeSummary
    private readonly attachOpFiredForDataStore = new Set<string>();

    private _connected: boolean;

    public get connected(): boolean {
        return this._connected;
    }

    private _disposed = false;
    public get disposed() { return this._disposed; }

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
        private readonly context: IContainerContext,
        registryEntries: NamedFluidDataStoreRegistryEntries,
        private readonly requestHandler?: (request: IRequest, runtime: IContainerRuntime) => Promise<IResponse>,
    ) {
        super();

        this.registry = new FluidDataStoreRegistry(registryEntries);

        this._connected = this.context.connected;

        this.IFluidHandleContext = new ContainerFluidHandleContext("", this);

        this.pendingStateManager = new PendingStateManager(this);
    }

    public dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;

        // close/stop all store contexts
        for (const [, contextD] of this.contextsDeferred) {
            contextD.promise.then((context) => {
                context.dispose();
            }).catch((contextError) => {
                console.log(contextError);
            });
        }

        this.emit("dispose");
        this.removeAllListeners();
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

    // Back-compat: <= 0.17
    public changeConnectionState(state: ConnectionState, clientId?: string) {
        if (state !== ConnectionState.Connecting) {
            this.setConnectionState(state === ConnectionState.Connected, clientId);
        }
    }

    public setConnectionState(connected: boolean, clientId?: string) {
        this.verifyNotClosed();

        // There might be no change of state due to Container calling this API after loading runtime.
        const changeOfState = this._connected !== connected;
        this._connected = connected;

        if (changeOfState && this.canSendOps()) {
            this.pendingStateManager.replayPendingStates();
        }

        for (const [, context] of this.contexts) {
            try {
                context.setConnectionState(connected, clientId);
            } catch (error) { }
        }

        raiseConnectedEvent(this, connected, clientId);
    }

    public process(message: ISequencedDocumentMessage, local: boolean) {
        this.verifyNotClosed();

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

    public async createRootDataStore(pkg: string | string[], rootDataStoreId: string): Promise<IFluidRouter>
    {
        const fluidDataStore = await this._createDataStore(pkg, rootDataStoreId);
        fluidDataStore.bindToContext();
        return fluidDataStore;
    }

    public createDetachedDataStore(): IFluidDataStoreContextDetached {
        const id = uuid();
        const context = new LocalDetachedFluidDataStoreContext(
            id,
            this,
            this.storage,
            (cr: IFluidDataStoreChannel) => this.bindFluidDataStore(cr),
            undefined,
        );
        this.setupNewContext(context);
        return context;
    }

    private async _createDataStore(pkg: string | string[], id = uuid()): Promise<IFluidDataStoreChannel> {
        return this._createFluidDataStoreContext(Array.isArray(pkg) ? pkg : [pkg], id).realize();
    }

    private canSendOps() {
        return true;
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
        this.verifyNotClosed();
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
        this.verifyNotClosed();
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
            this.attachOpFiredForDataStore.add(fluidDataStoreRuntime.id);
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const deferred = this.contextsDeferred.get(id)!;
        assert(deferred);
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const context = this.contexts.get(id)!;
        assert(context);
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

    public async getAbsoluteUrl(relativeUrl: string): Promise<string | undefined> {
        if (this.context.getAbsoluteUrl === undefined) {
            throw new Error("Driver does not implement getAbsoluteUrl");
        }
        if (this.attachState !== AttachState.Attached) {
            return undefined;
        }
        return this.context.getAbsoluteUrl(relativeUrl);
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
        localOpMetadata: unknown = undefined): void {
        this.verifyNotClosed();

        let clientSequenceNumber: number = -1;

        if (this.canSendOps()) {
            clientSequenceNumber = this.submitRuntimeMessage(
                type,
                content,
            );
        }

        // Let the PendingStateManager know that a message was submitted.
        this.pendingStateManager.onSubmitMessage(type, clientSequenceNumber, content, localOpMetadata);
    }

    private submitRuntimeMessage(
        type: ContainerMessageType,
        contents: any,
    ) {
        const payload: ContainerRuntimeMessage = { type, contents };
        return this.context.submitFn(payload);
    }

    /**
     * Throw an error if the runtime is closed.  Methods that are expected to potentially
     * be called after dispose due to asynchrony should not call this.
     */
    private verifyNotClosed() {
        if (this._disposed) {
            throw new Error("Runtime is closed");
        }
    }

    /**
     * Finds the right store and asks it to resubmit the message. This typically happens when we
     * reconnect and there are pending messages.
     * @param content - The content of the original message.
     * @param localOpMetadata - The local metadata associated with the original message.
     */
    private reSubmit(type: ContainerMessageType, content: any, localOpMetadata: unknown) {
        switch (type) {
            case ContainerMessageType.FluidDataStoreOp:
                // For Operations, call resubmitDataStoreOp which will find the right store
                // and trigger resubmission on it.
                this.resubmitDataStoreOp(content, localOpMetadata);
                break;
            case ContainerMessageType.Attach:
                this.submit(type, content, localOpMetadata);
                break;
            default:
                throw new Error(`Unknown ContainerMessageType: ${type}`);
        }
    }

    private resubmitDataStoreOp(content: any, localOpMetadata: unknown) {
        const envelope = content as IEnvelope;
        const context = this.getContext(envelope.address);
        assert(context, "There should be a store context for the op");
        context.reSubmit(envelope.contents, localOpMetadata);
    }
}
