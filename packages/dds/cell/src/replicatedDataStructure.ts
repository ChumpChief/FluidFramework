/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * Host-facing behavior for a distributed data structure (DDS) using ordered operations.
 * @remarks
 * The host owns transport identity, duplicate suppression, and delivery ordering.
 * Submitted operations are delivered exactly once in a consistent total order that preserves each sender's order.
 * Resubmission may replace or omit operations that have not been delivered.
 * Local acknowledgments arrive in submission order; rollback requests arrive in reverse submission order.
 * Operation and snapshot contents are interpreted by the DDS, not the host.
 * @internal
 */
export interface ReplicatedDataStructure {
	/**
	 * Starts replication once, after the host establishes the initial shared state.
	 * The callback must accept or queue operations synchronously, even while disconnected.
	 * It must not edit the DDS or deliver operations until it returns.
	 * Disconnection does not stop replication.
	 * Local metadata is optional, opaque to the host, and is not sent to other replicas.
	 * The host preserves its identity without encoding it and returns it on acknowledgment, resubmission, and rollback.
	 */
	startReplication(submit: (content: unknown, localMetadata?: unknown) => void): void;

	/**
	 * Processes decoded operation contents.
	 * A local operation acknowledges a previously applied edit rather than applying a new edit.
	 * Local metadata is the value supplied during submission, or undefined for remote operations.
	 */
	receive(content: unknown, local: boolean, localMetadata: unknown): void;

	/**
	 * Resubmits an unacknowledged operation without applying a second local edit.
	 * The DDS may submit zero, one, or multiple replacement operations, each with its own local metadata.
	 * The host replaces the original transport record with the resulting submissions.
	 * The DDS must adjust its pending state to match the resulting operations and acknowledgments.
	 * Several resubmit calls can occur before an acknowledgment arrives.
	 * @param content - Decoded contents of the original operation.
	 * @param localMetadata - Local metadata supplied with the original operation.
	 * @param squash - Whether to omit intermediate changes overwritten or removed by subsequent pending operations.
	 * A DDS may preserve its operations unchanged when squashing is requested.
	 */
	resubmit(content: unknown, localMetadata: unknown, squash: boolean): void;

	/**
	 * Replays a persisted operation as a local edit.
	 * Before replication starts, it updates local state without submission.
	 * After replication starts, submissions are captured by the host for the persisted transport record.
	 * Replay recreates any local metadata through those submissions rather than restoring it from operation contents.
	 */
	replay(content: unknown): void;

	/**
	 * Reverts the newest pending edit after the host withdraws it from delivery.
	 * The contents identify the operation being reverted; the DDS may use its own pending state instead.
	 * Local metadata is the value supplied during submission.
	 */
	rollback(content: unknown, localMetadata: unknown): void;

	/**
	 * Captures sequenced state synchronously, excluding pending local edits.
	 * Before replication starts, captures the current local state.
	 * The result must be serializable by the host and must not be undefined.
	 * Restoring pending edits also requires the host's delivery position and replay records.
	 */
	getSnapshot(): unknown;

	/**
	 * Returns retained data containing external references, without encoding or side effects.
	 * Include references in pending edits and any other state that may become visible after rollback.
	 * The host interprets reference values and determines their routes.
	 */
	getReferenceData(): unknown;
}

/**
 * A DDS instance and its scoped application-facing value.
 * They may be the same object exposed through different interfaces.
 * @typeParam TView - The application-facing interface.
 * @internal
 */
export interface DataStructureInstance<TView extends object> {
	readonly dds: ReplicatedDataStructure;
	readonly value: TView;
}

/**
 * Constructs local-only DDS instances without host-specific services.
 * @typeParam TView - The application-facing interface.
 * @internal
 */
export interface DataStructureDefinition<TView extends object> {
	create(): DataStructureInstance<TView>;

	/**
	 * Validates and restores snapshot contents after host-specific decoding.
	 * Restoration must not emit events or start replication.
	 */
	restore(snapshot: unknown): DataStructureInstance<TView>;
}
