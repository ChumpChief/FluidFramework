/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IContainer,
    IFluidModuleWithDetails,
} from "@fluidframework/container-definitions";
import {
    ContainerSchema,
    DOProviderModelContainerRuntimeFactory,
    IDOProviderModelType,
    IFluidContainer,
} from "../fluidStatic";
import { TinyliciousModelLoader } from "../modelLoader";
import {
    TinyliciousContainerServices,
} from "./interfaces";
import { TinyliciousAudience } from "./TinyliciousAudience";

function getContainerServices(
    container: IContainer,
): TinyliciousContainerServices {
    return {
        audience: new TinyliciousAudience(container),
    };
}

/**
 * Provides the ability to have a Fluid object backed by a Tinylicious service.
 *
 * See {@link https://fluidframework.com/docs/testing/tinylicious/}
 */
export class TinyliciousClientModel {
    /**
     * Creates a new detached container instance in Tinylicious server.
     * @param containerSchema - Container schema for the new container.
     * @returns New detached container instance along with associated services.
     */
    public async createContainer(
        containerSchema: ContainerSchema,
    ): Promise<{
        container: IFluidContainer;
        services: TinyliciousContainerServices;
        attach: () => Promise<string>;
    }> {
        const loader = this.createLoader(containerSchema);

        // We're not actually using the code proposal (our code loader always loads the same module
        // regardless of the proposal), but the Container will only give us a NullRuntime if there's
        // no proposal.  So we'll use a fake proposal.
        const { model, attach } = await loader.createDetached("no-dynamic-package");
        const { container, services } = model;
        return { container, services, attach };
    }

    /**
     * Accesses the existing container given its unique ID in the tinylicious server.
     * @param id - Unique ID of the container.
     * @param containerSchema - Container schema used to access data objects in the container.
     * @returns Existing container instance along with associated services.
     */
    public async getContainer(
        id: string,
        containerSchema: ContainerSchema,
    ): Promise<{ container: IFluidContainer; services: TinyliciousContainerServices; }> {
        const loader = this.createLoader(containerSchema);
        const { container, services } = await loader.loadExisting(id);
        return { container, services };
    }

    // #region private
    private createLoader(containerSchema: ContainerSchema) {
        console.log("MAKING MODEL LOADER");
        const containerRuntimeFactory = new DOProviderModelContainerRuntimeFactory(
            containerSchema,
            getContainerServices,
        );
        const load = async (): Promise<IFluidModuleWithDetails> => {
            return {
                module: { fluidExport: containerRuntimeFactory },
                details: { package: "no-dynamic-package", config: {} },
            };
        };

        const codeLoader = { load };
        const loader = new TinyliciousModelLoader<IDOProviderModelType>(codeLoader);
        return loader;
    }
    // #endregion
}
