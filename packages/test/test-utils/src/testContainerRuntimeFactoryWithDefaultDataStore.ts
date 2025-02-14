/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { IRuntimeFactory } from "@fluidframework/container-definitions/internal";
import type { IContainerRuntimeOptions } from "@fluidframework/container-runtime/internal";
import type { IContainerRuntime } from "@fluidframework/container-runtime-definitions/internal";
import type { FluidObject } from "@fluidframework/core-interfaces";
// eslint-disable-next-line import/no-deprecated
import type { RuntimeRequestHandler } from "@fluidframework/request-handler/internal";
import type {
	IFluidDataStoreFactory,
	NamedFluidDataStoreRegistryEntries,
} from "@fluidframework/runtime-definitions/internal";

const getDefaultFluidObject = async (runtime: IContainerRuntime) => {
	const entryPoint = await runtime.getAliasedDataStoreEntryPoint("default");
	if (entryPoint === undefined) {
		throw new Error("default dataStore must exist");
	}
	return entryPoint.get();
};

/**
 * Happens to match the constructor of ContainerRuntimeFactoryWithDefaultDataStore.
 * @internal
 */
export type CRFWDDSConstructor = new (props: {
	defaultFactory: IFluidDataStoreFactory;
	registryEntries: NamedFluidDataStoreRegistryEntries;
	dependencyContainer?: any;
	// eslint-disable-next-line import/no-deprecated
	requestHandlers?: RuntimeRequestHandler[];
	runtimeOptions?: IContainerRuntimeOptions;
	provideEntryPoint?: (runtime: IContainerRuntime) => Promise<FluidObject>;
}) => IRuntimeFactory;

/**
 * ! Note: This function is purely needed for back-compat as the constructor argument structure was changed
 * @internal
 */
export const createContainerRuntimeFactoryWithDefaultDataStore = (
	ctor: CRFWDDSConstructor,
	ctorArgs: {
		defaultFactory: IFluidDataStoreFactory;
		registryEntries: NamedFluidDataStoreRegistryEntries;
		dependencyContainer?: any;
		// eslint-disable-next-line import/no-deprecated
		requestHandlers?: RuntimeRequestHandler[];
		runtimeOptions?: IContainerRuntimeOptions;
		provideEntryPoint?: (runtime: IContainerRuntime) => Promise<FluidObject>;
	},
): IRuntimeFactory => {
	try {
		return new ctor(ctorArgs);
	} catch (err) {
		// IMPORTANT: The constructor argument structure changed, so this is needed for dynamically using older ContainerRuntimeFactoryWithDefaultDataStore's
		const {
			defaultFactory,
			registryEntries,
			dependencyContainer,
			requestHandlers,
			runtimeOptions,
			provideEntryPoint,
		} = ctorArgs;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return new (ctor as any)(
			defaultFactory,
			registryEntries,
			dependencyContainer,
			requestHandlers,
			runtimeOptions,
			provideEntryPoint ?? getDefaultFluidObject,
		);
	}
};
