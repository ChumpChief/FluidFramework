/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IRequest,
    IResponse,
} from "@fluidframework/core-interfaces";
import {
    IAudience,
    IContainerContext,
    IDeltaManager,
    IRuntime,
    ICriticalContainerError,
    ContainerWarning,
    AttachState,
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    IClientDetails,
    IDocumentMessage,
    IQuorum,
    ISequencedDocumentMessage,
    IServiceConfiguration,
    ISignalMessage,
    ISnapshotTree,
    MessageType,
    ISummaryTree,
} from "@fluidframework/protocol-definitions";
import { assert } from "@fluidframework/common-utils";
import { Container } from "./container";

export class ContainerContext implements IContainerContext {
    public static async createOrLoad(
        container: Container,
        runtimeFactory: IRuntimeFactory,
        baseSnapshot: ISnapshotTree | undefined,
        deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        quorum: IQuorum,
        raiseContainerWarning: (warning: ContainerWarning) => void,
        submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        submitSignalFn: (contents: any) => void,
        closeFn: (error?: ICriticalContainerError) => void,
    ): Promise<ContainerContext> {
        const context = new ContainerContext(
            container,
            runtimeFactory,
            baseSnapshot,
            deltaManager,
            quorum,
            raiseContainerWarning,
            submitFn,
            submitSignalFn,
            closeFn,
        );
        await context.load();
        return context;
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

    public get connected(): boolean {
        return this.container.connected;
    }

    public get serviceConfiguration(): IServiceConfiguration | undefined {
        return this.container.serviceConfiguration;
    }

    public get audience(): IAudience {
        return this.container.audience;
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
        public readonly deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        public readonly quorum: IQuorum,
        public readonly raiseContainerWarning: (warning: ContainerWarning) => void,
        public readonly submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        public readonly submitSignalFn: (contents: any) => void,
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

    private async load() {
        this._runtime = await this.runtimeFactory.instantiateRuntime(this);
    }
}
