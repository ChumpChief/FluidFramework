/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { AttachState } from "@fluidframework/container-definitions";
import { assert } from "@fluidframework/core-utils/internal";
import type {
	ChannelWithEntryPoint,
	IChannelAttributes,
	IChannelServices,
	IDeltaHandler,
	IFluidDataStoreRuntime,
	IFluidDataStoreRuntimeInternalConfig,
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

import type {
	DataStructureDefinition,
	ReplicatedDataStructure,
} from "./replicatedDataStructure.js";

/**
 * An experimental Fluid adapter for an ordered-operation distributed data structure (DDS).
 * @remarks
 * The runtime manages this adapter, while handles resolve to its application-facing entry point.
 * The DDS owns data and replication behavior. This adapter owns Fluid lifecycle and encoding.
 * Snapshots are synchronous and stored in a single blob.
 * Local operation metadata and squash requests pass through to the DDS without interpretation.
 * @typeParam TView - The application-facing interface.
 * @internal
 */
export class DdsChannel<TView extends object> implements ChannelWithEntryPoint<TView> {
	public readonly dds: ReplicatedDataStructure;
	public readonly entryPoint: TView;
	public readonly handle: SharedObjectHandle<TView>;
	private readonly serializer: FluidSerializer;
	private services: IChannelServices | undefined;
	private bound = false;
	private binding = false;
	private replicating = false;

	public get IFluidLoadable(): this {
		return this;
	}

	/**
	 * Constructs a local-only DDS using the supplied definition.
	 * The factory connects loaded channels after construction.
	 * @param snapshot - Encoded initial state to restore, or undefined to create a new DDS.
	 */
	public constructor(
		public readonly id: string,
		private readonly runtime: IFluidDataStoreRuntime,
		public readonly attributes: IChannelAttributes,
		definition: DataStructureDefinition<TView>,
		snapshot?: unknown,
	) {
		assert(!id.includes("/"), "Channel id cannot contain slashes");
		this.verifyUsable();
		this.serializer = new FluidSerializer(runtime.channelsRoutingContext);
		const instance =
			snapshot === undefined
				? definition.create()
				: definition.restore(this.serializer.decode(snapshot));
		this.dds = instance.dds;
		this.entryPoint = instance.value;
		this.handle = new SharedObjectHandle(this, this.entryPoint, id, runtime);
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
			this.serializer.stringify(this.dds.getSnapshot(), this.handle),
		);
	}

	public async summarize(): Promise<ISummaryTreeWithStats> {
		return this.getAttachSummary();
	}

	public getGCData(): IGarbageCollectionData {
		this.verifyUsable();
		const visitor = new GCHandleVisitor(this.runtime.channelsRoutingContext);
		visitor.stringify(this.dds.getReferenceData(), this.handle);
		return { gcNodes: { "/": visitor.getVisitedHandlePaths() } };
	}

	private readonly startReplicationIfAttached = (): void => {
		if (!this.replicating && this.services !== undefined && this.isAttached()) {
			this.verifyUsable();
			this.dds.startReplication((operation, localMetadata) =>
				this.submit(operation, localMetadata),
			);
			this.replicating = true;
			this.runtime.off("attaching", this.startReplicationIfAttached);
		}
	};

	private readonly deltaHandler: IDeltaHandler = {
		processMessages: ({ local, messagesContent }) => {
			this.verifyUsable();
			for (const { contents, localOpMetadata } of messagesContent) {
				this.dds.receive(this.serializer.decode(contents), local, localOpMetadata);
			}
		},
		// Disconnection changes delivery, not replication state. The runtime queues edits.
		setConnectionState: () => {},
		reSubmit: (content: unknown, localOpMetadata: unknown, squash?: boolean) => {
			this.verifyUsable();
			this.dds.resubmit(this.serializer.decode(content), localOpMetadata, squash === true);
		},
		applyStashedOp: (content: unknown) => {
			this.verifyUsable();
			this.dds.replay(this.serializer.decode(content));
		},
		rollback: (content: unknown, localOpMetadata: unknown) => {
			this.verifyUsable();
			this.dds.rollback(this.serializer.decode(content), localOpMetadata);
		},
	};

	private submit(operation: unknown, localMetadata: unknown): void {
		this.verifyUsable();
		assert(this.services !== undefined, "Replicating channel must have services");
		const onlyBind =
			(this.runtime as IFluidDataStoreRuntimeInternalConfig)
				.submitMessagesWithoutEncodingHandles === true;
		const content = onlyBind
			? bindHandles(operation, this.handle)
			: this.serializer.encode(operation, this.handle);
		this.services.deltaConnection.submit(content, localMetadata);
	}

	private verifyUsable(): void {
		if (this.runtime.disposed) {
			throw new Error("DdsChannel runtime is disposed");
		}
	}
}
