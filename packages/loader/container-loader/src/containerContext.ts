/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import {
    IFluidConfiguration,
    IRequest,
    IResponse,
} from "@fluidframework/core-interfaces";
import {
    IAudience,
    IContainerContext,
    IDeltaManager,
    ILoader,
    IRuntime,
    IRuntimeFactory,
    ICriticalContainerError,
    AttachState,
} from "@fluidframework/container-definitions";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    ConnectionState,
    IClientDetails,
    IDocumentMessage,
    IQuorum,
    ISequencedDocumentMessage,
    IServiceConfiguration,
    ISignalMessage,
    ISnapshotTree,
    ITree,
    MessageType,
    ISummaryTree,
    IVersion,
} from "@fluidframework/protocol-definitions";
import { BlobManager } from "./blobManager";
import { Container } from "./container";
import { NullRuntime } from "./nullRuntime";

export class ContainerContext implements IContainerContext {
    public static async createOrLoad(
        container: Container,
        runtimeFactory: IRuntimeFactory,
        baseSnapshot: ISnapshotTree | null,
        blobManager: BlobManager | undefined,
        deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        quorum: IQuorum,
        loader: ILoader,
        submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        submitSignalFn: (contents: any) => void,
        snapshotFn: (message: string) => Promise<void>,
        closeFn: (error?: ICriticalContainerError) => void,
    ): Promise<ContainerContext> {
        const context = new ContainerContext(
            container,
            runtimeFactory,
            baseSnapshot,
            blobManager,
            deltaManager,
            quorum,
            loader,
            submitFn,
            submitSignalFn,
            snapshotFn,
            closeFn,
        );
        await context.load();
        return context;
    }

    public get id(): string {
        return this.container.id;
    }

    public get clientId(): string | undefined {
        return this.container.clientId;
    }

    public get clientDetails(): IClientDetails {
        return this.container.clientDetails;
    }

    public get existing(): boolean | undefined {
        return this.container.existing;
    }

    // Back-compat: supporting <= 0.16 data stores
    public get connectionState(): ConnectionState {
        return this.connected ? ConnectionState.Connected : ConnectionState.Disconnected;
    }

    public get connected(): boolean {
        return this.container.connected;
    }

    public get canSummarize(): boolean {
        return "summarize" in this.runtime;
    }

    public get serviceConfiguration(): IServiceConfiguration | undefined {
        return this.container.serviceConfiguration;
    }

    public get audience(): IAudience {
        return this.container.audience;
    }

    public get options(): any {
        return this.container.options;
    }

    public get configuration(): IFluidConfiguration {
        const config: Partial<IFluidConfiguration> = {
            canReconnect: this.container.canReconnect,
            scopes: this.container.scopes,
        };
        return config as IFluidConfiguration;
    }

    public get IMessageScheduler() {
        return this;
    }

    public get baseSnapshot() {
        return this._baseSnapshot;
    }

    public get storage(): IDocumentStorageService | undefined | null {
        return this.container.storage;
    }

    private _runtime: IRuntime | undefined;
    private get runtime() {
        if (this._runtime === undefined) {
            throw new Error("Attempted to access runtime before it was defined");
        }
        return this._runtime;
    }

    private _disposed = false;

    public get disposed() {
        return this._disposed;
    }

    constructor(
        private readonly container: Container,
        public readonly runtimeFactory: IRuntimeFactory,
        private readonly _baseSnapshot: ISnapshotTree | null,
        public readonly blobManager: BlobManager | undefined,
        public readonly deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        public readonly quorum: IQuorum,
        public readonly loader: ILoader,
        public readonly submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        public readonly submitSignalFn: (contents: any) => void,
        public readonly snapshotFn: (message: string) => Promise<void>,
        public readonly closeFn: (error?: ICriticalContainerError) => void,
    ) {
        this.attachListener();
    }

    private attachListener() {
        this.container.once("attaching", () => {
            this._runtime?.setAttachState?.(AttachState.Attaching);
        });
        this.container.once("attached", () => {
            this._runtime?.setAttachState?.(AttachState.Attached);
        });
    }

    public dispose(error?: Error): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;

        this.runtime.dispose(error);
        this.quorum.dispose();
        this.deltaManager.dispose();
    }

    public async snapshot(tagMessage: string = "", fullTree: boolean = false): Promise<ITree | null> {
        return this.runtime.snapshot(tagMessage, fullTree);
    }

    public getLoadedFromVersion(): IVersion | undefined {
        return this.container.loadedFromVersion;
    }

    public get attachState(): AttachState {
        return this.container.attachState;
    }

    public createSummary(): ISummaryTree {
        return this.runtime.createSummary();
    }

    public setConnectionState(connected: boolean, clientId?: string) {
        const runtime = this.runtime;

        assert.strictEqual(connected, this.connected, "Mismatch in connection state while setting");

        // Back-compat: supporting <= 0.16 data stores
        if (runtime.setConnectionState !== undefined) {
            runtime.setConnectionState(connected, clientId);
        } else if (runtime.changeConnectionState !== undefined) {
            runtime.changeConnectionState(this.connectionState, clientId);
        } else {
            assert.fail("Runtime missing both setConnectionState and changeConnectionState");
        }
    }

    public process(message: ISequencedDocumentMessage, local: boolean, context: any) {
        this.runtime.process(message, local, context);
    }

    public processSignal(message: ISignalMessage, local: boolean) {
        this.runtime.processSignal(message, local);
    }

    public async request(path: IRequest): Promise<IResponse> {
        return this.runtime.request(path);
    }

    public async requestSnapshot(tagMessage: string): Promise<void> {
        return this.snapshotFn(tagMessage);
    }

    public registerTasks(tasks: string[]): any {
        return;
    }

    public hasNullRuntime() {
        return this.runtime instanceof NullRuntime;
    }

    private async load() {
        this._runtime = await this.runtimeFactory.instantiateRuntime(this);
    }
}
