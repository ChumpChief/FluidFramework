/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type {
	IContainerContext,
	IRuntime,
	IRuntimeFactory,
} from "@fluidframework/container-definitions/legacy";
import { loadContainerRuntime } from "@fluidframework/container-runtime/legacy";
import type { IContainerRuntime } from "@fluidframework/container-runtime-definitions/legacy";
import type { IFluidHandle } from "@fluidframework/core-interfaces";
import { v4 as uuid } from "uuid";

import { BlobCollectionFactory, type IBlobCollection } from "./blobCollection/index.js";

const blobCollectionId = "blob-collection";
const blobCollectionRegistryKey = "blob-collection";
const blobCollectionFactory = new BlobCollectionFactory();

export interface IBlobCollectionEntryPoint {
	blobCollection: IBlobCollection;
	createDetachedBlobCollection: () => Promise<{
		detachedBlobCollection: IBlobCollection;
		attachRuntime: () => Promise<void>;
	}>;
}

export class BlobCollectionContainerRuntimeFactory implements IRuntimeFactory {
	public get IRuntimeFactory(): IRuntimeFactory {
		return this;
	}

	public async instantiateRuntime(
		context: IContainerContext,
		existing: boolean,
	): Promise<IRuntime> {
		const provideEntryPoint = async (
			entryPointRuntime: IContainerRuntime,
		): Promise<IBlobCollectionEntryPoint> => {
			const blobCollectionHandle = (await entryPointRuntime.getAliasedDataStoreEntryPoint(
				blobCollectionId,
			)) as IFluidHandle<IBlobCollection>;
			if (blobCollectionHandle === undefined) {
				throw new Error("Blob collection missing!");
			}
			const createDetachedBlobCollection = async () => {
				const detachedBlobCollectionContext = entryPointRuntime.createDetachedDataStore([
					blobCollectionRegistryKey,
				]);
				const detachedBlobCollectionRuntime = await blobCollectionFactory.instantiateDataStore(
					detachedBlobCollectionContext,
					false,
				);
				const detachedBlobCollection =
					(await detachedBlobCollectionRuntime.entryPoint.get()) as IBlobCollection;
				const attachRuntime = async () => {
					const detachedBlobCollectionDataStore =
						await detachedBlobCollectionContext.attachRuntime(
							blobCollectionFactory,
							detachedBlobCollectionRuntime,
						);
					await detachedBlobCollectionDataStore.trySetAlias(uuid());
				};
				return {
					detachedBlobCollection,
					attachRuntime,
				};
			};
			return {
				blobCollection: await blobCollectionHandle.get(),
				createDetachedBlobCollection,
			};
		};

		const runtime = await loadContainerRuntime({
			context,
			registryEntries: new Map([
				[blobCollectionRegistryKey, Promise.resolve(blobCollectionFactory)],
			]),
			provideEntryPoint,
			existing,
		});

		if (!existing) {
			const blobCollection = await runtime.createDataStore(blobCollectionRegistryKey);
			await blobCollection.trySetAlias(blobCollectionId);
		}

		return runtime;
	}
}
