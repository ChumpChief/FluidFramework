/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IContainerContext, IRuntime, IRuntimeFactory } from "@fluidframework/container-definitions";
import {
    FluidDataStoreRegistry,
} from "@fluidframework/container-runtime";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import {
    IRequest,
} from "@fluidframework/core-interfaces";
import {
    IFluidDataStoreRegistry,
    IProvideFluidDataStoreRegistry,
    NamedFluidDataStoreRegistryEntries,
} from "@fluidframework/runtime-definitions";
import {
    ContainerRuntime,
} from "./containerRuntime";
import { DiceRollerInstantiationFactory } from "./dataObject";

const defaultDataStoreId = "default";

export class DiceRollerContainerRuntimeFactory implements
    IProvideFluidDataStoreRegistry,
    IRuntimeFactory {
    public get IFluidDataStoreRegistry() { return this.registry; }
    public get IRuntimeFactory() { return this; }
    private readonly registryEntries: NamedFluidDataStoreRegistryEntries = new Map([
        DiceRollerInstantiationFactory.registryEntry,
    ]);
    private readonly registry: IFluidDataStoreRegistry = new FluidDataStoreRegistry(this.registryEntries);

    /**
     * {@inheritDoc @fluidframework/container-definitions#IRuntimeFactory.instantiateRuntime}
     */
    public async instantiateRuntime(
        context: IContainerContext,
    ): Promise<IRuntime> {
        const runtime = await ContainerRuntime.load(
            context,
            this.registryEntries,
            async (request: IRequest, containerRuntime: IContainerRuntime) =>
                containerRuntime.IFluidHandleContext.resolveHandle(request),
        );

        if (!runtime.existing) {
            const router = await runtime.createRootDataStore(
                DiceRollerInstantiationFactory.type,
                defaultDataStoreId,
            );
            // We need to request the data store before attaching to ensure it
            // runs through its entire instantiation flow.
            await router.request({ url: "/" });
        }

        return runtime;
    }
}

/**
 * The DiceRollerContainerRuntimeFactory is the container code for our scenario.
 *
 * Since we only need to instantiate and retrieve a single dice roller for our scenario, we can use a
 * ContainerRuntimeFactoryWithDefaultDataStore. We provide it with the type of the data object we want to create
 * and retrieve by default, and the registry entry mapping the type to the factory.
 *
 * This container code will create the single default data object on our behalf and make it available on the
 * Container with a URL of "/", so it can be retrieved via container.request("/").
 */
export const diceRollerContainerRuntimeFactory = new DiceRollerContainerRuntimeFactory();
