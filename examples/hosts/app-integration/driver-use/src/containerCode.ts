/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import {
    deprecated_innerRequestHandler,
} from "@fluidframework/request-handler";
import { BaseContainerRuntimeFactory } from "./baseContainerRuntimeFactory";
import { DiceRollerInstantiationFactory } from "./dataObject";
import { defaultRouteRequestHandler } from "./requestHandlers";

const defaultDataStoreId = "default";

/**
 * A ContainerRuntimeFactory that initializes Containers with a single default data store, which can be requested from
 * the container with an empty URL.
 *
 * This factory should be exposed as fluidExport off the entry point to your module.
 */
class DiceRollerContainerRuntimeFactory extends BaseContainerRuntimeFactory {
    public static readonly defaultDataStoreId = defaultDataStoreId;

    constructor() {
        super(
            new Map([
                DiceRollerInstantiationFactory.registryEntry,
            ]),
            [
                defaultRouteRequestHandler(defaultDataStoreId),
                deprecated_innerRequestHandler,
            ],
        );
    }

    /**
     * {@inheritDoc BaseContainerRuntimeFactory.containerInitializingFirstTime}
     */
    protected async containerInitializingFirstTime(runtime: IContainerRuntime) {
        const router = await runtime.createRootDataStore(
            DiceRollerInstantiationFactory.type,
            defaultDataStoreId,
        );
        // We need to request the data store before attaching to ensure it
        // runs through its entire instantiation flow.
        await router.request({ url: "/" });
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
