/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { IFluidHandleInternal } from "@fluidframework/core-interfaces/internal";
import { FluidObjectHandle } from "@fluidframework/datastore/internal";
import type {
	IChannel,
	IFluidDataStoreRuntime,
} from "@fluidframework/datastore-definitions/internal";
import { isFluidHandle } from "@fluidframework/runtime-utils/internal";

import type { ISharedObject } from "./types.js";

/**
 * Handle supporting reference binding. See also {@link SharedObjectHandle}.
 * The referenced object need not implement {@link ISharedObject}.
 * Supports binding other handles to the underlying Shared Object (see {@link ISharedObjectHandle.bind}).
 *
 * @internal
 */
export interface ISharedObjectHandle extends IFluidHandleInternal {
	/**
	 * Binds the given handle to this DDS or attach the given handle if this DDS is attached.
	 * A bound handle will also be attached once this DDS is attached.
	 *
	 * @param handle - The target handle to bind to this DDS
	 */
	bind(handle: IFluidHandleInternal): void;
}

/**
 * Type guard for {@link ISharedObjectHandle}.
 * @internal
 */
export function isISharedObjectHandle(handle: unknown): handle is ISharedObjectHandle {
	return isFluidHandle(handle) && typeof (handle as ISharedObjectHandle).bind === "function";
}

/**
 * Handle for a shared object (DDS).
 *
 * @remarks
 *
 * This object is used for already loaded (in-memory) channels and their application-facing values.
 *
 * It provides a "bind" function that is expected to be invoked on all handles stored in this DDS,
 * ensuring the target object becomes attached along with this DDS.
 * The channel need not implement the app-facing or event APIs of {@link ISharedObject}.
 * @typeParam T - The application-facing value returned by the handle.
 * @internal
 */
export class SharedObjectHandle<T extends object = ISharedObject>
	extends FluidObjectHandle<T>
	implements ISharedObjectHandle
{
	/**
	 * Whether services have been attached for the associated shared object.
	 */
	public get isAttached(): boolean {
		return this.channel.isAttached();
	}

	/**
	 * Tells whether the object of this handle is visible in the container locally or globally.
	 */
	private get isVisible(): boolean {
		/**
		 * If the object of this handle is attached, it is visible in the container. Ideally, checking local visibility
		 * should be enough for a handle. However, there are scenarios where the object becomes locally visible but the
		 * handle does not know this - This will happen is attachGraph is never called on the handle. Couple of examples
		 * where this can happen:
		 *
		 * 1. Handles to DDS other than the default handle won't know if the DDS becomes visible after the handle was
		 * created.
		 *
		 * 2. Handles to root data stores will never know that it was visible because the handle will not be stores in
		 * another DDS and so, attachGraph will never be called on it.
		 */
		return this.isAttached || this.isLocallyVisible;
	}

	/**
	 * Tracks whether this handle is locally visible in the container.
	 */
	private isLocallyVisible: boolean = false;

	private readonly pendingHandles: Set<IFluidHandleInternal> = new Set();

	/**
	 * Creates a new SharedObjectHandle.
	 * @param channel - The channel responsible for attachment and binding.
	 * @param value - The application-facing value returned by `get`.
	 * @param path - The channel id, relative to the runtime's handle context.
	 * @param runtime - The data store runtime containing the channel.
	 */
	constructor(
		private readonly channel: Pick<IChannel, "isAttached"> & { bindToContext(): void },
		protected readonly value: T,
		path: string,
		private readonly runtime: IFluidDataStoreRuntime,
	) {
		super(value, path, runtime.IFluidHandleContext);
	}

	public override async get(): Promise<T> {
		return this.value;
	}

	/**
	 * Attaches all bound handles first (which may in turn attach further handles), then attaches this handle.
	 * When attaching the handle, it registers the associated shared object.
	 */
	public attachGraph(): void {
		if (this.isVisible) {
			return;
		}

		// Recursively attach all pending handles
		this.isLocallyVisible = true;
		for (const handle of this.pendingHandles) {
			handle.attachGraph();
		}
		this.pendingHandles.clear();

		// Bind this SharedObject to its context (typically the DataStore) so it attaches with it
		this.channel.bindToContext();

		// This will trigger the context (typically the DataStore) to attach its graph
		super.attachGraph();
	}

	public bind(handle: IFluidHandleInternal): void {
		// We don't bind handles in staging mode to defer the attachment of any new objects
		// until we've exited staging mode. This way if we discard changes or a new handle is not present in the final
		// committed state, we will never end up attaching the discarded object.
		if (this.runtime.inStagingMode === true) {
			return;
		}

		// If this handle is visible, attach the graph of the incoming handle as well.
		if (this.isVisible) {
			handle.attachGraph();
			return;
		}

		// If this handle is not visible, we will attach it later when this handle's attachGraph is called.
		this.pendingHandles.add(handle);
	}
}
