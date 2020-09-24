/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { BaseContainerRuntimeFactory, defaultRouteRequestHandler } from "@fluidframework/aqueduct";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import {
    deprecated_innerRequestHandler,
} from "@fluidframework/request-handler";

import { DiceRollerInstantiationFactory } from "./dataObject";

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

export const diceRollerContainerRuntimeFactory = new DiceRollerContainerRuntimeFactory();
