/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IContainerContext, IRuntime } from "@fluidframework/container-definitions/internal";
import {
	ContainerRuntime,
	IContainerRuntimeOptions,
} from "@fluidframework/container-runtime/internal";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions/internal";
import type { FluidObject } from "@fluidframework/core-interfaces";
import type {
	NamedFluidDataStoreRegistryEntries,
	NamedFluidDataStoreRegistryEntry2,
} from "@fluidframework/runtime-definitions/internal";

import type { IEntryPointPiece } from "./interfaces.js";

// TODO: CompositeEntryPoint isn't really the right name - this is more like CompositeContainerContents
// or CompositeContainerCode?
/**
 * @alpha
 */
export class CompositeEntryPoint {
	private readonly _entryPointPieces: Map<string, IEntryPointPiece> = new Map();

	public readonly addEntryPointPiece = (
		name: string,
		entryPointPiece: IEntryPointPiece,
	): void => {
		// TODO: Consider validating no conflicts (e.g. name already exists, registry entry collision)
		this._entryPointPieces.set(name, entryPointPiece);
	};

	public get registryEntries(): NamedFluidDataStoreRegistryEntries {
		const registryEntries: NamedFluidDataStoreRegistryEntry2[] = [];
		for (const entryPointPiece of this._entryPointPieces.values()) {
			registryEntries.push(...entryPointPiece.registryEntries);
		}
		return registryEntries;
	}

	public readonly onCreate = async (runtime: IContainerRuntime): Promise<void> => {
		for (const entryPointPiece of this._entryPointPieces.values()) {
			await entryPointPiece.onCreate(runtime);
		}
	};

	public readonly onLoad = async (runtime: IContainerRuntime): Promise<void> => {
		for (const entryPointPiece of this._entryPointPieces.values()) {
			await entryPointPiece.onLoad(runtime);
		}
	};

	public readonly provideEntryPoint = async (
		runtime: IContainerRuntime,
	): Promise<Record<string, FluidObject>> => {
		const entryPoint: Record<string, FluidObject> = {};
		for (const [name, entryPointPiece] of this._entryPointPieces) {
			entryPoint[name] = await entryPointPiece.createPiece(runtime);
		}
		return entryPoint;
	};
}

/**
 * TODO: Make lint happy
 * @alpha
 */
export const loadCompositeRuntime = async (
	context: IContainerContext,
	existing: boolean,
	compositeEntryPoint: CompositeEntryPoint,
	runtimeOptions?: IContainerRuntimeOptions,
): Promise<IContainerRuntime & IRuntime> => {
	const runtime = await ContainerRuntime.loadRuntime({
		context,
		registryEntries: compositeEntryPoint.registryEntries,
		provideEntryPoint: compositeEntryPoint.provideEntryPoint,
		runtimeOptions,
		existing,
	});

	if (!existing) {
		await compositeEntryPoint.onCreate(runtime);
	}
	await compositeEntryPoint.onLoad(runtime);

	return runtime;
};
