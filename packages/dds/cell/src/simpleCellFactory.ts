/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { IFluidHandle } from "@fluidframework/core-interfaces";
import { assert, isObject } from "@fluidframework/core-utils/internal";
import type {
	IChannelAttributes,
	IChannelFactory,
	IChannelServices,
	IFluidDataStoreRuntime,
	Serializable,
} from "@fluidframework/datastore-definitions/internal";
import { readAndParse } from "@fluidframework/driver-utils/internal";

import { pkgVersion } from "./packageVersion.js";
import type { SimpleCellView } from "./simpleCell.js";
import { SimpleCellChannel } from "./simpleCellChannel.js";

/**
 * Factory for the experimental {@link SimpleCellChannel}.
 * Its type and snapshot format are separate from the existing Cell.
 * @internal
 */
export class SimpleCellFactory implements IChannelFactory<SimpleCellChannel> {
	public static readonly Type = "https://graph.microsoft.com/types/experimental-simple-cell";
	public static readonly Attributes: IChannelAttributes = {
		type: SimpleCellFactory.Type,
		snapshotFormatVersion: "0.1",
		packageVersion: pkgVersion,
	};

	public readonly type = SimpleCellFactory.Type;
	public readonly attributes = SimpleCellFactory.Attributes;

	public create(runtime: IFluidDataStoreRuntime, id: string): SimpleCellChannel {
		return new SimpleCellChannel(id, runtime, this.attributes);
	}

	public async load(
		runtime: IFluidDataStoreRuntime,
		id: string,
		services: IChannelServices,
		attributes: IChannelAttributes,
	): Promise<SimpleCellChannel> {
		assert(
			attributes.type === this.type &&
				attributes.snapshotFormatVersion === this.attributes.snapshotFormatVersion,
			"Unsupported SimpleCell channel type or snapshot format",
		);
		const snapshot = await readAndParse<unknown>(services.objectStorage, "header");
		assert(
			isObject(snapshot) && !Array.isArray(snapshot),
			"SimpleCell snapshot must be an object",
		);
		const channel = new SimpleCellChannel(id, runtime, attributes, {
			value: "value" in snapshot ? snapshot.value : undefined,
		});
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
		channel instanceof SimpleCellChannel,
		"The registered SimpleCell factory must create a SimpleCellChannel",
	);
	return { value: channel.entryPoint, handle: channel.handle };
}
