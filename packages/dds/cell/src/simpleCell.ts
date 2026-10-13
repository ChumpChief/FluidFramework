/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { createEmitter } from "@fluid-internal/client-utils";
import type { Listenable } from "@fluidframework/core-interfaces/internal";
import { isObject } from "@fluidframework/core-utils/internal";

import type { ReplicatedDataStructure } from "./replicatedDataStructure.js";

/**
 * An edit to a {@link SimpleCell}.
 * Payload values are opaque to Cell; their encoding and validation belong to the host.
 * @internal
 */
export type SimpleCellOperation<T> =
	| { readonly type: "setCell"; readonly value: { readonly value: T } }
	| { readonly type: "deleteCell" };

/**
 * The visible value of a Cell, including pending local edits.
 * An absent or undefined value represents an empty Cell.
 * @internal
 */
export interface SimpleCellSnapshot<T> {
	readonly value?: T | undefined;
}

/**
 * Synchronously accepts an operation for delivery, including while disconnected.
 * @remarks
 * The host owns operation identity and ordering.
 * During resubmission or replay, associate this call with the original transport record
 * instead of creating a second sequenced edit.
 *
 * Queue incoming delivery until this callback returns.
 * The callback may read the Cell, but must not edit it or invoke its replication methods.
 * This is a host precondition, not a restriction enforced by Cell.
 * A thrown exception faults the Cell because acceptance of the operation is uncertain.
 * @internal
 */
export type SimpleCellSubmit<T> = (
	operation: SimpleCellOperation<T>,
	localMetadata: unknown,
) => void;

interface SimpleCellLocalMetadata<T> {
	readonly pendingMessageId: number;
	readonly previousValue: T | undefined;
}

interface PendingOperation<T> {
	readonly operation: SimpleCellOperation<T>;
	readonly metadata: SimpleCellLocalMetadata<T>;
}

/**
 * Data-change events, including local edits, remote edits, replay, and rollback.
 * Acknowledgments and resubmissions do not emit these events.
 * @internal
 */
export interface SimpleCellEvents<T> {
	valueChanged: (value: T) => void;
	delete: () => void;
}

/**
 * The application-facing API for reading and editing a {@link SimpleCell}.
 * @typeParam T - The value type. Values are not cloned; callers must not mutate stored payloads.
 * @remarks
 * Replication, lifecycle, and snapshot methods are reserved for the host.
 * This interface scopes access to the existing Cell instance; it does not create a separate object.
 * @internal
 */
export interface SimpleCellView<T = unknown> {
	/**
	 * Returns the visible value, including pending local edits.
	 */
	get(): T | undefined;

	/**
	 * Sets the visible value and emits `valueChanged`, even if the value is unchanged.
	 */
	set(value: T): void;

	/**
	 * Clears the visible value and emits `delete`, even if the Cell is already empty.
	 */
	delete(): void;

	/**
	 * Returns whether the visible value is undefined.
	 */
	empty(): boolean;

	/**
	 * Subscribes to data changes without exposing event emission.
	 * @remarks
	 * Registering the same listener twice for an event throws an Error.
	 * Adding a listener during notification does not include it in that notification.
	 * Removing a listener before its turn skips it.
	 * The function returned by `on` unsubscribes the listener.
	 */
	readonly events: Listenable<SimpleCellEvents<T>>;
}

/**
 * An experimental replicated Cell independent of the Fluid runtime.
 * @typeParam T - The value type. Values are not cloned; callers must not mutate stored payloads.
 * @remarks
 * Construct a Cell for local use, then call {@link SimpleCell.startReplication} to provide a host.
 * The host must deliver operations in a consistent total order, preserving each sender's order,
 * with exactly one acknowledgment in place of each local operation.
 * Transport identity, duplicate suppression, persistence, and reconnection belong to the host.
 *
 * Edits update state and register pending work before publication, then notify listeners.
 * Listeners may make nested edits; their operations are published after the outer edit.
 * Listener notifications are synchronous and depth-first.
 *
 * Publication or listener exceptions propagate and permanently fault the Cell.
 * Subsequent edits, replication calls, and snapshot requests throw an Error with the original
 * failure as its cause. Reads through {@link SimpleCell.get} and {@link SimpleCell.empty} remain available.
 * @internal
 */
export class SimpleCell<T = unknown> implements SimpleCellView<T>, ReplicatedDataStructure {
	private value: T | undefined;
	private readonly pending: PendingOperation<T>[] = [];
	private messageId = -1;
	private submit: SimpleCellSubmit<T> | undefined;
	private failure: Error | undefined;

	private readonly emitter = createEmitter<SimpleCellEvents<T>>();

	/**
	 * {@inheritDoc SimpleCellView.events}
	 */
	public readonly events: Listenable<SimpleCellEvents<T>> = this.emitter;

	/**
	 * Restores a snapshot, or creates an empty local-only Cell.
	 * Restoration does not emit events or start replication.
	 */
	public constructor(snapshot: SimpleCellSnapshot<T> = {}) {
		this.value = snapshot.value;
	}

	/**
	 * {@inheritDoc SimpleCellView.get}
	 */
	public get(): T | undefined {
		return this.value;
	}

	/**
	 * {@inheritDoc SimpleCellView.empty}
	 */
	public empty(): boolean {
		return this.value === undefined;
	}

	/**
	 * {@inheritDoc SimpleCellView.set}
	 */
	public set(value: T): void {
		this.applyLocal({ type: "setCell", value: { value } });
	}

	/**
	 * {@inheritDoc SimpleCellView.delete}
	 */
	public delete(): void {
		this.applyLocal({ type: "deleteCell" });
	}

	/**
	 * Starts replication once, returning the initial state for the host to share.
	 * @remarks
	 * Earlier local-only edits are represented by this snapshot, not submitted as operations.
	 * Establish this snapshot on other replicas before delivering subsequent operations.
	 * Disconnection must not undo this transition: the host must continue accepting edits.
	 * @throws An Error if replication has already started.
	 */
	public startReplication(submit: SimpleCellSubmit<T>): SimpleCellSnapshot<T> {
		this.verifyNotFaulted();
		if (this.submit !== undefined) {
			throw new Error("Replication has already started");
		}
		this.submit = submit;
		return this.getSnapshot();
	}

	/**
	 * Processes an operation in sequencing order.
	 * Local operations acknowledge the oldest pending edit without reapplying it or notifying listeners.
	 * Remote operations are ignored while local edits are pending, matching the existing Cell.
	 * The host must deliver each operation exactly once and preserve submission order.
	 * @param content - Operation contents after any host-specific decoding.
	 * @param local - Whether the operation acknowledges an edit from this Cell.
	 * @param localMetadata - The metadata supplied with the local operation, or undefined for a remote operation.
	 * @throws An Error if replication has not started or a local operation has no pending edit to acknowledge.
	 * @throws A TypeError if the contents do not describe a supported Cell operation.
	 */
	public receive(content: unknown, local: boolean, localMetadata: unknown): void {
		this.verifyReplicating();
		const operation = parseOperation<T>(content);
		if (local) {
			const first = this.pending[0];
			if (first === undefined) {
				throw new Error("Cannot acknowledge without a pending operation");
			}
			const metadata = parseLocalMetadata<T>(localMetadata);
			if (metadata.pendingMessageId !== first.metadata.pendingMessageId) {
				throw new Error("Acknowledgment does not match the oldest pending operation");
			}
			this.pending.shift();
			return;
		}

		if (this.pending.length === 0) {
			this.value = operationValue(operation);
			this.notify(operation);
		}
	}

	/**
	 * Publishes an existing pending edit without applying it again or changing the pending queue.
	 * @remarks
	 * The host supplies unacknowledged operations in their original submission order and suppresses duplicate delivery.
	 * Several operations may be resubmitted before any acknowledgments arrive.
	 * Resubmission preserves the original local metadata, including the rollback value and pending message ID.
	 * @param content - Operation contents after any host-specific decoding.
	 * @param localMetadata - The metadata supplied with the original operation.
	 * @param _squash - Cell preserves its operations unchanged even when squashing is requested.
	 * @throws An Error if replication has not started.
	 * @throws A TypeError if the contents do not describe a supported Cell operation.
	 */
	public resubmit(content: unknown, localMetadata: unknown, _squash = false): void {
		const submit = this.verifyReplicating();
		const operation = parseOperation<T>(content);
		parseLocalMetadata<T>(localMetadata);
		this.invokeCallback(() => submit(operation, localMetadata));
	}

	/**
	 * Recreates a persisted operation as a local edit.
	 * @remarks
	 * Restore the host's replay baseline and replay pending edits in their original order.
	 * Before replication starts, replay updates local state without publication or pending operations.
	 * After replication starts, replay also publishes the edit.
	 * Each replayed edit creates fresh local metadata from the value it replaces.
	 * The host must associate replay submissions with persisted transport records,
	 * including edits already sequenced before the restart.
	 * @param content - Operation contents after any host-specific decoding.
	 * @throws A TypeError if the contents do not describe a supported Cell operation.
	 */
	public replay(content: unknown): void {
		this.verifyNotFaulted();
		this.applyLocal(parseOperation<T>(content));
	}

	/**
	 * Removes the newest pending edit and emits an event for the restored visible value.
	 * @remarks
	 * The host must withdraw the newest pending operation from delivery before calling this method.
	 * Multiple edits must be rolled back in reverse submission order.
	 * An operation already sequenced cannot be rolled back.
	 * Rollback restores the previous value captured when the edit was made.
	 * Remote operations ignored while the edit was pending are not recovered.
	 * @param content - Operation contents after any host-specific decoding.
	 * @param localMetadata - The original operation's pending message ID and previous value.
	 * @throws An Error if replication has not started or there are no pending edits.
	 */
	public rollback(content: unknown, localMetadata: unknown): void {
		this.verifyReplicating();
		parseOperation<T>(content);
		const last = this.pending.at(-1);
		if (last === undefined) {
			throw new Error("Cannot roll back without a pending operation");
		}
		const metadata = parseLocalMetadata<T>(localMetadata);
		if (metadata.pendingMessageId !== last.metadata.pendingMessageId) {
			throw new Error("Rollback does not match the newest pending operation");
		}
		this.pending.pop();
		this.value = metadata.previousValue;
		this.notify(
			this.value === undefined
				? { type: "deleteCell" }
				: { type: "setCell", value: { value: this.value } },
		);
	}

	/**
	 * Captures the current visible value, matching the existing Cell's snapshot.
	 * @remarks
	 * This includes pending local edits but does not capture their metadata or delivery state.
	 * Replaying pending edits requires a host-selected baseline that precedes those edits,
	 * along with the host's delivery position and pending transport records.
	 * Values are not cloned or encoded.
	 */
	public getSnapshot(): SimpleCellSnapshot<T> {
		this.verifyNotFaulted();
		return { value: this.value };
	}

	/**
	 * Captures pending edits in replay order.
	 * Operation records are copied; their value payloads are not cloned.
	 */
	public getPendingOperations(): readonly SimpleCellOperation<T>[] {
		this.verifyNotFaulted();
		return this.pending.map(({ operation }) =>
			operation.type === "setCell"
				? { ...operation, value: { ...operation.value } }
				: { ...operation },
		);
	}

	/**
	 * Returns visible and pending data, including rollback values, for host reference traversal.
	 */
	public getReferenceData(): unknown {
		return { snapshot: this.getSnapshot(), pending: this.pending };
	}

	private applyLocal(operation: SimpleCellOperation<T>): void {
		this.verifyNotFaulted();
		const previousValue = this.value;
		this.value = operationValue(operation);
		const submit = this.submit;
		if (submit !== undefined) {
			const metadata = { pendingMessageId: ++this.messageId, previousValue };
			this.pending.push({ operation, metadata });
			this.invokeCallback(() => submit(operation, metadata));
		}
		this.notify(operation);
	}

	private notify(operation: SimpleCellOperation<T>): void {
		this.invokeCallback(() => {
			if (operation.type === "setCell") {
				this.emitter.emit("valueChanged", operation.value.value);
			} else {
				this.emitter.emit("delete");
			}
		});
	}

	private invokeCallback(callback: () => void): void {
		try {
			callback();
			this.verifyNotFaulted();
		} catch (error) {
			this.failure ??= new Error("SimpleCell is faulted", { cause: error });
			throw error;
		}
	}

	private verifyNotFaulted(): void {
		if (this.failure !== undefined) {
			throw this.failure;
		}
	}

	private verifyReplicating(): SimpleCellSubmit<T> {
		this.verifyNotFaulted();
		if (this.submit === undefined) {
			throw new Error("Replication has not started");
		}
		return this.submit;
	}
}

/**
 * Validates the operation shape; payload typing is the host's responsibility.
 */
function parseOperation<T>(content: unknown): SimpleCellOperation<T> {
	if (!isObject(content) || !("type" in content)) {
		throw new TypeError("SimpleCell operation must be an object with a type");
	}
	switch (content.type) {
		case "setCell": {
			if (!("value" in content) || !isObject(content.value) || Array.isArray(content.value)) {
				throw new TypeError("SimpleCell set operation must contain a value wrapper");
			}
			return {
				type: "setCell",
				value: {
					value: ("value" in content.value ? content.value.value : undefined) as T,
				},
			};
		}
		case "deleteCell": {
			return { type: "deleteCell" };
		}
		default: {
			throw new TypeError("Unsupported SimpleCell operation");
		}
	}
}

function parseLocalMetadata<T>(metadata: unknown): SimpleCellLocalMetadata<T> {
	if (
		!isObject(metadata) ||
		!("pendingMessageId" in metadata) ||
		typeof metadata.pendingMessageId !== "number"
	) {
		throw new TypeError("SimpleCell local metadata must contain a pending message ID");
	}
	return {
		pendingMessageId: metadata.pendingMessageId,
		previousValue: ("previousValue" in metadata ? metadata.previousValue : undefined) as
			| T
			| undefined,
	};
}

function operationValue<T>(operation: SimpleCellOperation<T>): T | undefined {
	switch (operation.type) {
		case "setCell": {
			return operation.value.value;
		}
		case "deleteCell": {
			return undefined;
		}
		default: {
			throw new TypeError("Unsupported SimpleCell operation");
		}
	}
}
