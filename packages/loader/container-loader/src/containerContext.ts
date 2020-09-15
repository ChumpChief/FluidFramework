/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import {
    IFluidConfiguration,
    IRequest,
    IResponse,
} from "@fluidframework/core-interfaces";
import {
    IContainerContext,
    IRuntime,
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    ConnectionState,
    ISequencedDocumentMessage,
    IServiceConfiguration,
    ISignalMessage,
    MessageType,
} from "@fluidframework/protocol-definitions";
import { Container } from "./container";

export class ContainerContext implements IContainerContext {
    public static async createOrLoad(
        container: Container,
        runtimeFactory: IRuntimeFactory,
        submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        submitSignalFn: (contents: any) => void,
    ): Promise<ContainerContext> {
        const context = new ContainerContext(
            container,
            runtimeFactory,
            submitFn,
            submitSignalFn,
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

    public get serviceConfiguration(): IServiceConfiguration | undefined {
        return this.container.serviceConfiguration;
    }

    public get options(): any {
        return {};
    }

    public get configuration(): IFluidConfiguration {
        const config: Partial<IFluidConfiguration> = {
            canReconnect: this.container.canReconnect,
            scopes: this.container.scopes,
        };
        return config as IFluidConfiguration;
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
        public readonly submitFn: (type: MessageType, contents: any, batch: boolean, appData: any) => number,
        public readonly submitSignalFn: (contents: any) => void,
    ) { }

    public dispose(error?: Error): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;

        this.runtime.dispose(error);
    }

    public setConnectionState(connected: boolean, clientId?: string) {
        assert.strictEqual(connected, this.connected, "Mismatch in connection state while setting");
        this.runtime.setConnectionState(connected, clientId);
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

    public registerTasks(tasks: string[]): any {
        return;
    }

    public async getAbsoluteUrl(relativeUrl: string): Promise<string | undefined> {
        throw new Error("getAbsoluteUrl not implemented");
    }

    private async load() {
        this._runtime = await this.runtimeFactory.instantiateRuntime(this);
    }
}
