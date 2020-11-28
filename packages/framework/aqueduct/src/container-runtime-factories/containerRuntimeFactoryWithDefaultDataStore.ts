/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IFluidDataStoreFactory, NamedFluidDataStoreRegistryEntries } from "@fluidframework/runtime-definitions";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import {
    innerRequestHandler,
} from "@fluidframework/request-handler";
import { defaultRouteRequestHandler } from "../request-handlers";
import { BaseContainerRuntimeFactory } from "./baseContainerRuntimeFactory";

const defaultDataStoreId = "default";

/**
 * A ContainerRuntimeFactory that initializes Containers with a single default data store, which can be requested from
 * the container with an empty URL.
 *
 * This factory should be exposed as fluidExport off the entry point to your module.
 */
export class ContainerRuntimeFactoryWithDefaultDataStore extends BaseContainerRuntimeFactory {
    public static readonly defaultDataStoreId = defaultDataStoreId;

    constructor(
        protected readonly defaultFactory: IFluidDataStoreFactory,
        registryEntries: NamedFluidDataStoreRegistryEntries,
    ) {
        super(
            registryEntries,
            [
                defaultRouteRequestHandler(defaultDataStoreId),
                innerRequestHandler,
            ],
        );
    }

    /**
     * {@inheritDoc BaseContainerRuntimeFactory.containerInitializingFirstTime}
     */
    protected async containerInitializingFirstTime(runtime: IContainerRuntime) {
        await runtime.createRootDataStore(
            this.defaultFactory.type,
            defaultDataStoreId,
        );
    }
}
