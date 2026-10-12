/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { IFluidHandle } from "@fluidframework/core-interfaces";
import { assert, isObject } from "@fluidframework/core-utils/internal";
import type {
	IChannelAttributes,
	IChannel,
	IChannelFactory,
	IChannelServices,
	IFluidDataStoreRuntime,
	Serializable,
} from "@fluidframework/datastore-definitions/internal";
import { readAndParse } from "@fluidframework/driver-utils/internal";

import { DdsChannel } from "./ddsChannel.js";
import { pkgVersion } from "./packageVersion.js";
import type {
	DataStructureDefinition,
	DataStructureInstance,
} from "./replicatedDataStructure.js";
import { SimpleCell, type SimpleCellView } from "./simpleCell.js";

/**
 * Constructs Cell instances for the generic channel without exposing host services to Cell.
 */
const simpleCellDefinition: DataStructureDefinition<SimpleCellView<Serializable<unknown>>> = {
	create: () => createCellInstance(undefined),
	restore: (snapshot) => {
		if (!isObject(snapshot) || Array.isArray(snapshot)) {
			throw new TypeError("SimpleCell snapshot must be an object");
		}
		return createCellInstance(
			("value" in snapshot ? snapshot.value : undefined) as Serializable<unknown>,
		);
	},
};

function createCellInstance(
	value: Serializable<unknown> | undefined,
): DataStructureInstance<SimpleCellView<Serializable<unknown>>> {
	const cell = new SimpleCell<Serializable<unknown>>({ value });
	return { dds: cell, value: cell };
}

/**
 * Factory for experimental Cells hosted by {@link DdsChannel}.
 * Its type and snapshot format are separate from the existing Cell.
 * @internal
 */
export class SimpleCellFactory
	implements IChannelFactory<DdsChannel<SimpleCellView<Serializable<unknown>>>>
{
	public static readonly Type = "https://graph.microsoft.com/types/experimental-simple-cell";
	public static readonly Attributes: IChannelAttributes = {
		type: SimpleCellFactory.Type,
		snapshotFormatVersion: "0.1",
		packageVersion: pkgVersion,
	};

	public readonly type = SimpleCellFactory.Type;
	public readonly attributes = SimpleCellFactory.Attributes;

	public create(
		runtime: IFluidDataStoreRuntime,
		id: string,
	): DdsChannel<SimpleCellView<Serializable<unknown>>> {
		return new DdsChannel(id, runtime, this.attributes, simpleCellDefinition);
	}

	public async load(
		runtime: IFluidDataStoreRuntime,
		id: string,
		services: IChannelServices,
		attributes: IChannelAttributes,
	): Promise<DdsChannel<SimpleCellView<Serializable<unknown>>>> {
		assert(
			attributes.type === this.type &&
				attributes.snapshotFormatVersion === this.attributes.snapshotFormatVersion,
			"Unsupported SimpleCell channel type or snapshot format",
		);
		const snapshot = await readAndParse<unknown>(services.objectStorage, "header");
		const channel = new DdsChannel(id, runtime, attributes, simpleCellDefinition, snapshot);
		channel.connect(services);
		return channel;
	}
}

/**
 * Creates an experimental Cell's application-facing view and its Fluid handle.
 * @remarks
 * Register {@link SimpleCellFactory} with the runtime before calling this function.
 * The new channel is initially unbound; store its handle in an attached object to share it.
 * The runtime retains the adapter, and the handle resolves to `value`.
 * Both expose {@link SimpleCellView}, not the Cell's host-facing methods.
 * @internal
 */
export function createSimpleCell(
	runtime: IFluidDataStoreRuntime,
	id?: string,
): {
	readonly value: SimpleCellView<Serializable<unknown>>;
	readonly handle: IFluidHandle<SimpleCellView<Serializable<unknown>>>;
} {
	const channel = runtime.createChannel(id, SimpleCellFactory.Type);
	assert(
		isSimpleCellChannel(channel),
		"The registered SimpleCell factory must create a Cell hosted by DdsChannel",
	);
	return { value: channel.entryPoint, handle: channel.handle };
}

/**
 * Narrows a runtime channel to a Cell hosted by the experimental adapter.
 * @internal
 */
export function isSimpleCellChannel(
	channel: IChannel,
): channel is DdsChannel<SimpleCellView<Serializable<unknown>>> {
	return (
		channel instanceof DdsChannel &&
		channel.attributes.type === SimpleCellFactory.Type &&
		channel.dds instanceof SimpleCell
	);
}
