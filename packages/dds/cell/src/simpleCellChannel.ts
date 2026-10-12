/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { AttachState } from "@fluidframework/container-definitions";
import { assert, isObject } from "@fluidframework/core-utils/internal";
import type {
	IChannel,
	IChannelAttributes,
	IChannelServices,
	IDeltaHandler,
	IFluidDataStoreRuntime,
	IFluidDataStoreRuntimeInternalConfig,
	Serializable,
} from "@fluidframework/datastore-definitions/internal";
import type {
	IGarbageCollectionData,
	ISummaryTreeWithStats,
} from "@fluidframework/runtime-definitions/internal";
import {
	bindHandles,
	createSingleBlobSummary,
	FluidSerializer,
	GCHandleVisitor,
	SharedObjectHandle,
} from "@fluidframework/shared-object-base/internal";

import {
	SimpleCell,
	type SimpleCellOperation,
	type SimpleCellSnapshot,
} from "./simpleCell.js";

/**
 * A Fluid channel containing a standalone {@link SimpleCell}.
 * @remarks
 * The runtime and handles expose this adapter; applications use its `cell`.
 * Cell owns the data and replication algorithm. This adapter owns Fluid lifecycle and encoding.
 * Squashed resubmission is not supported by this experiment.
 * @typeParam T - The Fluid-serializable value type.
 * @internal
 */
export class SimpleCellChannel<T = unknown> implements IChannel {
	public readonly cell: SimpleCell<Serializable<T>>;
	public readonly handle: SharedObjectHandle<SimpleCellChannel<T>>;
	private readonly serializer: FluidSerializer;
	private services: IChannelServices | undefined;
	private bound = false;
	private binding = false;
	private replicating = false;

	public get IFluidLoadable(): this {
		return this;
	}

	/**
	 * Creates a local channel, optionally from an encoded snapshot.
	 * The factory connects loaded channels after construction.
	 */
	public constructor(
		public readonly id: string,
		private readonly runtime: IFluidDataStoreRuntime,
		public readonly attributes: IChannelAttributes,
		snapshot: SimpleCellSnapshot<unknown> = {},
	) {
		assert(!id.includes("/"), "Channel id cannot contain slashes");
		this.verifyUsable();
		this.serializer = new FluidSerializer(runtime.channelsRoutingContext);
		this.cell = new SimpleCell<Serializable<T>>({
			value: this.serializer.decode(snapshot.value) as Serializable<T> | undefined,
		});
		this.handle = new SharedObjectHandle(this, id, runtime);
		runtime.once("attaching", this.startReplicationIfAttached);
		runtime.once("dispose", () => runtime.off("attaching", this.startReplicationIfAttached));
	}

	/**
	 * Binds this channel to its runtime when its handle becomes visible.
	 */
	public bindToContext(): void {
		this.verifyUsable();
		if (this.bound || this.binding) {
			return;
		}
		this.binding = true;
		this.runtime.bindChannel(this);
		this.bound = true;
		this.startReplicationIfAttached();
	}

	public isAttached(): boolean {
		return this.bound && this.runtime.attachState !== AttachState.Detached;
	}

	public connect(services: IChannelServices): void {
		this.verifyUsable();
		if (this.services !== undefined) {
			assert(this.services === services, "Channel cannot connect to different services");
			return;
		}
		this.services = services;
		this.bound = true;
		this.startReplicationIfAttached();
		services.deltaConnection.attach(this.deltaHandler);
	}

	public getAttachSummary(): ISummaryTreeWithStats {
		this.verifyUsable();
		return createSingleBlobSummary(
			"header",
			this.serializer.stringify(this.cell.getSnapshot(), this.handle),
		);
	}

	public async summarize(): Promise<ISummaryTreeWithStats> {
		return this.getAttachSummary();
	}

	public getGCData(): IGarbageCollectionData {
		this.verifyUsable();
		const visitor = new GCHandleVisitor(this.runtime.channelsRoutingContext);
		// Pending values can become the sequenced value or be exposed by rollback.
		visitor.stringify(
			{ snapshot: this.cell.getSnapshot(), pending: this.cell.getPendingOperations() },
			this.handle,
		);
		return { gcNodes: { "/": visitor.getVisitedHandlePaths() } };
	}

	private readonly startReplicationIfAttached = (): void => {
		if (!this.replicating && this.services !== undefined && this.isAttached()) {
			this.verifyUsable();
			this.cell.startReplication((operation) => this.submit(operation));
			this.replicating = true;
			this.runtime.off("attaching", this.startReplicationIfAttached);
		}
	};

	private readonly deltaHandler: IDeltaHandler = {
		processMessages: ({ local, messagesContent }) => {
			this.verifyUsable();
			for (const { contents } of messagesContent) {
				if (local) {
					this.cell.acknowledge();
				} else {
					this.cell.receive(this.decodeOperation(contents));
				}
			}
		},
		// Disconnection changes delivery, not Cell's replication state. The runtime queues edits.
		setConnectionState: () => {},
		reSubmit: (content: unknown, _localOpMetadata: unknown, squash?: boolean) => {
			this.verifyUsable();
			if (squash === true) {
				throw new Error("SimpleCell does not support squashed resubmission");
			}
			this.cell.resubmit(this.decodeOperation(content));
		},
		applyStashedOp: (content: unknown) => {
			this.verifyUsable();
			const operation = this.decodeOperation(content);
			if (this.replicating) {
				this.cell.replay(operation);
			} else if (operation.type === "set") {
				this.cell.set(operation.value);
			} else {
				this.cell.delete();
			}
		},
		rollback: () => {
			this.verifyUsable();
			this.cell.rollback();
		},
	};

	private decodeOperation(content: unknown): SimpleCellOperation<Serializable<T>> {
		const decoded = this.serializer.decode(content);
		assert(
			isObject(decoded) && "type" in decoded,
			"SimpleCell operation must be an object with a type",
		);
		switch (decoded.type) {
			case "set": {
				return {
					type: "set",
					value: ("value" in decoded ? decoded.value : undefined) as Serializable<T>,
				};
			}
			case "delete": {
				return { type: "delete" };
			}
			default: {
				throw new Error("Unsupported SimpleCell operation");
			}
		}
	}

	private submit(operation: SimpleCellOperation<Serializable<T>>): void {
		this.verifyUsable();
		assert(this.services !== undefined, "Replicating channel must have services");
		const onlyBind =
			(this.runtime as IFluidDataStoreRuntimeInternalConfig)
				.submitMessagesWithoutEncodingHandles === true;
		const content = onlyBind
			? bindHandles(operation, this.handle)
			: this.serializer.encode(operation, this.handle);
		this.services.deltaConnection.submit(content, undefined);
	}

	private verifyUsable(): void {
		if (this.runtime.disposed) {
			throw new Error("SimpleCellChannel runtime is disposed");
		}
	}
}
