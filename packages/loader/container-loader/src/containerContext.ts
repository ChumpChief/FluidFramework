/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ITelemetryLogger } from "@fluidframework/common-definitions";
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
    IRuntimeState,
    ICriticalContainerError,
    ContainerWarning,
    AttachState,
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    IClientDetails,
    IDocumentAttributes,
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
import { assert } from "@fluidframework/common-utils";
import { Container } from "./container";

export class ContainerContext implements IContainerContext {
    public static async createOrLoad(
        container: Container,
        runtimeFactory: IRuntimeFactory,
        baseSnapshot: ISnapshotTree | undefined,
        attributes: IDocumentAttributes,
        deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        quorum: IQuorum,
        loader: ILoader,
        raiseContainerWarning: (warning: ContainerWarning) => void,
        submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        submitSignalFn: (contents: any) => void,
        snapshotFn: (message: string) => Promise<void>,
        closeFn: (error?: ICriticalContainerError) => void,
        version: string,
        previousRuntimeState: IRuntimeState,
    ): Promise<ContainerContext> {
        const context = new ContainerContext(
            container,
            runtimeFactory,
            baseSnapshot,
            attributes,
            deltaManager,
            quorum,
            loader,
            raiseContainerWarning,
            submitFn,
            submitSignalFn,
            snapshotFn,
            closeFn,
            version,
            previousRuntimeState);
        await context.load();
        return context;
    }

    public readonly logger: ITelemetryLogger;

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

    public get branch(): string {
        return this.attributes.branch;
    }

    public get runtimeVersion(): string | undefined {
        return this.runtime?.runtimeVersion;
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return this.container.options;
    }

    public get configuration(): IFluidConfiguration {
        const config: Partial<IFluidConfiguration> = {
            scopes: this.container.scopes,
        };
        return config as IFluidConfiguration;
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
        private readonly runtimeFactory: IRuntimeFactory,
        private readonly _baseSnapshot: ISnapshotTree | undefined,
        private readonly attributes: IDocumentAttributes,
        public readonly deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        public readonly quorum: IQuorum,
        public readonly loader: ILoader,
        public readonly raiseContainerWarning: (warning: ContainerWarning) => void,
        public readonly submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        public readonly submitSignalFn: (contents: any) => void,
        public readonly snapshotFn: (message: string) => Promise<void>,
        public readonly closeFn: (error?: ICriticalContainerError) => void,
        public readonly version: string,
        public readonly previousRuntimeState: IRuntimeState,
    ) {
        this.logger = container.subLogger;
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

    /**
     * Snapshot and close the runtime, and return its state if available
     */
    public async snapshotRuntimeState(): Promise<IRuntimeState> {
        return this.runtime.stop();
    }

    public get attachState(): AttachState {
        return this.container.attachState;
    }

    public createSummary(): ISummaryTree {
        return this.runtime.createSummary();
    }

    public setConnectionState(connected: boolean, clientId?: string) {
        const runtime = this.runtime;

        assert(connected === this.connected, "Mismatch in connection state while setting");

        runtime.setConnectionState(connected, clientId);
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

    private async load() {
        this._runtime = await this.runtimeFactory.instantiateRuntime(this);
    }
}
