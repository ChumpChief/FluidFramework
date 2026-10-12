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
	| { readonly type: "set"; readonly value: T }
	| { readonly type: "delete" };

/**
 * The sequenced state of a Cell, without pending local edits.
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
export type SimpleCellSubmit<T> = (operation: SimpleCellOperation<T>) => void;

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
	private sequencedValue: T | undefined;
	private readonly pending: SimpleCellOperation<T>[] = [];
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
		this.sequencedValue = snapshot.value;
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
		this.applyLocal({ type: "set", value });
	}

	/**
	 * {@inheritDoc SimpleCellView.delete}
	 */
	public delete(): void {
		this.applyLocal({ type: "delete" });
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
	 * Pending local edits keep their visible value until acknowledged or rolled back.
	 * The host must deliver each operation exactly once and preserve submission order.
	 * @param content - Operation contents after any host-specific decoding.
	 * @param local - Whether the operation acknowledges an edit from this Cell.
	 * @throws An Error if replication has not started or a local operation has no pending edit to acknowledge.
	 * @throws A TypeError if the contents do not describe a supported Cell operation.
	 */
	public receive(content: unknown, local: boolean): void {
		this.verifyReplicating();
		const operation = parseOperation<T>(content);
		if (local) {
			const first = this.pending[0];
			if (first === undefined) {
				throw new Error("Cannot acknowledge without a pending operation");
			}
			this.sequencedValue = operationValue(first);
			this.pending.shift();
			return;
		}

		const value = operationValue(operation);
		this.sequencedValue = value;
		if (this.pending.length === 0) {
			this.value = value;
			this.notify(operation);
		}
	}

	/**
	 * Publishes an existing pending edit without applying it again or changing the pending queue.
	 * @remarks
	 * The host supplies unacknowledged operations in their original submission order and suppresses duplicate delivery.
	 * Several operations may be resubmitted before any acknowledgments arrive.
	 * Cell trusts the host to supply the correct operation; it does not match operation identities.
	 * @param content - Operation contents after any host-specific decoding.
	 * @throws An Error if replication has not started.
	 * @throws A TypeError if the contents do not describe a supported Cell operation.
	 */
	public resubmit(content: unknown): void {
		const submit = this.verifyReplicating();
		const operation = parseOperation<T>(content);
		this.invokeCallback(() => submit(operation));
	}

	/**
	 * Recreates a persisted operation as a local edit.
	 * @remarks
	 * Restore the sequenced snapshot and replay pending edits in their original order.
	 * Before replication starts, replay updates local state without publication or pending operations.
	 * After replication starts, replay also publishes the edit.
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
	 * Without other pending edits, rollback reveals the latest sequenced value, including
	 * remote edits received while the rolled-back edit was pending.
	 * @param _content - The host-supplied operation contents. Cell uses its pending queue rather than inspecting them.
	 * @throws An Error if replication has not started or there are no pending edits.
	 */
	public rollback(_content: unknown): void {
		this.verifyReplicating();
		if (this.pending.length === 0) {
			throw new Error("Cannot roll back without a pending operation");
		}
		this.pending.pop();
		const remaining = this.pending.at(-1);
		this.value = remaining === undefined ? this.sequencedValue : operationValue(remaining);
		this.notify(
			this.value === undefined ? { type: "delete" } : { type: "set", value: this.value },
		);
	}

	/**
	 * Captures sequenced state, or current state before replication starts.
	 * @remarks
	 * This may differ from {@link SimpleCell.get} while local edits are pending.
	 * To restore such a replica, also persist {@link SimpleCell.getPendingOperations},
	 * the host's delivery position, and pending transport identities.
	 * Values are not cloned or encoded.
	 */
	public getSnapshot(): SimpleCellSnapshot<T> {
		this.verifyNotFaulted();
		return { value: this.sequencedValue };
	}

	/**
	 * Captures pending edits in replay order.
	 * Operation records are copied; their value payloads are not cloned.
	 */
	public getPendingOperations(): readonly SimpleCellOperation<T>[] {
		this.verifyNotFaulted();
		return this.pending.map((operation) => ({ ...operation }));
	}

	/**
	 * Returns sequenced and pending data for host reference traversal without encoding it.
	 */
	public getReferenceData(): unknown {
		return { snapshot: this.getSnapshot(), pending: this.getPendingOperations() };
	}

	private applyLocal(operation: SimpleCellOperation<T>): void {
		this.verifyNotFaulted();
		this.value = operationValue(operation);
		const submit = this.submit;
		if (submit === undefined) {
			this.sequencedValue = this.value;
		} else {
			this.pending.push(operation);
			this.invokeCallback(() => submit(operation));
		}
		this.notify(operation);
	}

	private notify(operation: SimpleCellOperation<T>): void {
		this.invokeCallback(() => {
			if (operation.type === "set") {
				this.emitter.emit("valueChanged", operation.value);
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
		case "set": {
			return {
				type: "set",
				value: ("value" in content ? content.value : undefined) as T,
			};
		}
		case "delete": {
			return { type: "delete" };
		}
		default: {
			throw new TypeError("Unsupported SimpleCell operation");
		}
	}
}

function operationValue<T>(operation: SimpleCellOperation<T>): T | undefined {
	switch (operation.type) {
		case "set": {
			return operation.value;
		}
		case "delete": {
			return undefined;
		}
		default: {
			throw new TypeError("Unsupported SimpleCell operation");
		}
	}
}
