/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
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
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";
import { Container } from "./container";

export class ContainerContext implements IContainerContext {
    public static async createOrLoad(
        container: Container,
        runtimeFactory: IRuntimeFactory,
        submitFn: (contents: any) => number,
    ): Promise<ContainerContext> {
        const context = new ContainerContext(
            container,
            runtimeFactory,
            submitFn,
        );
        await context.load();
        return context;
    }

    public get clientId(): string | undefined {
        return this.container.clientId;
    }

    public get existing(): boolean {
        return this.container.existing;
    }

    public get connected(): boolean {
        return this.container.connected;
    }

    public get storage(): IDocumentStorageService {
        return this.container.storage;
    }

    private _runtime: IRuntime | undefined;
    private get runtime() {
        if (this._runtime === undefined) {
            throw new Error("Attempted to access runtime before it was defined");
        }
        return this._runtime;
    }

    constructor(
        private readonly container: Container,
        public readonly runtimeFactory: IRuntimeFactory,
        public readonly submitFn: (contents: any) => number,
    ) { }

    public setConnectionState(connected: boolean) {
        this.runtime.setConnectionState(true);
    }

    public process(message: ISequencedDocumentMessage, local: boolean) {
        this.runtime.process(message, local);
    }

    public async request(path: IRequest): Promise<IResponse> {
        return this.runtime.request(path);
    }

    private async load() {
        this._runtime = await this.runtimeFactory.instantiateRuntime(this);
    }
}
