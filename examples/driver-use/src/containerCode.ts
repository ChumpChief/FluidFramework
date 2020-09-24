/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { defaultRouteRequestHandler } from "@fluidframework/aqueduct";
import { IContainerContext, IRuntime, IRuntimeFactory } from "@fluidframework/container-definitions";
import {
    ContainerRuntime,
} from "@fluidframework/container-runtime";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    buildRuntimeRequestHandler,
    deprecated_innerRequestHandler,
} from "@fluidframework/request-handler";

import { DiceRollerInstantiationFactory } from "./dataObject";

const defaultDataStoreId = "default";

/**
 * BaseContainerRuntimeFactory produces container runtimes with a given data store and service registry, as well as
 * given request handlers.  It can be subclassed to implement a first-time initialization procedure for the containers
 * it creates.
 */
export class DiceRollerContainerRuntimeFactory implements IRuntimeFactory {
    public get IRuntimeFactory() { return this; }

    /**
     * {@inheritDoc @fluidframework/container-definitions#IRuntimeFactory.instantiateRuntime}
     */
    public async instantiateRuntime(
        context: IContainerContext,
    ): Promise<IRuntime> {
        return this.instantiateRuntimeCore(
            context.existing,
            context.submitFn,
            context.storage,
        );
    }

    public async instantiateRuntimeCore(
        existing: boolean,
        submitFn: (contents: any) => number,
        storage: IDocumentStorageService,
    ): Promise<IRuntime> {
        const runtime = new ContainerRuntime(
            existing,
            submitFn,
            storage,
            new Map([
                DiceRollerInstantiationFactory.registryEntry,
            ]),
            buildRuntimeRequestHandler(
                defaultRouteRequestHandler(defaultDataStoreId),
                deprecated_innerRequestHandler,
            ),
        );

        if (!runtime.existing) {
            // If it's the first time through.
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

export const diceRollerContainerRuntimeFactory = new DiceRollerContainerRuntimeFactory();
