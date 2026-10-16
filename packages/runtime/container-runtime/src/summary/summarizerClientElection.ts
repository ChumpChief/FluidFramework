/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type { IDeltaManager } from "@fluidframework/container-definitions/internal";
import type {
	IEvent,
	IEventProvider,
	ITelemetryBaseLogger,
} from "@fluidframework/core-interfaces";
import type {
	IClient,
	IClientDetails,
	IQuorumClients,
	ISequencedClient,
} from "@fluidframework/driver-definitions";
import { MessageType } from "@fluidframework/driver-definitions/internal";
import {
	createChildLogger,
	type TelemetryLoggerExt,
} from "@fluidframework/telemetry-utils/internal";

import { summarizerClientType } from "./summarizerTypes.js";
import type { ISummaryCollectionOpEvents } from "./summaryCollection.js";

function isClientEligible(client: ISequencedClient): boolean {
	const details: IClient["details"] | undefined = client.client.details;
	return (
		details === undefined || SummarizerClientElection.clientDetailsPermitElection(details)
	);
}

/**
 * Serialized state of the summarizer election.
 * @internal
 */
export interface ISerializedElection {
	/**
	 * Sequence number at the time of the latest election.
	 */
	readonly electionSequenceNumber: number;

	/**
	 * Most recently elected client id. This is either:
	 *
	 * 1. the interactive elected parent client, in which case electedClientId === electedParentId,
	 * and the SummaryManager on the elected client will spawn a summarizer client, or
	 *
	 * 2. the non-interactive summarizer client itself.
	 */
	readonly electedClientId: string | undefined;

	/**
	 * Most recently elected parent client id. This is always an interactive client.
	 */
	readonly electedParentId: string | undefined;
}

export interface ISummarizerClientElectionEvents extends IEvent {
	(event: "electedSummarizerChanged", handler: () => void): void;
}

export interface ISummarizerClientElection
	extends IEventProvider<ISummarizerClientElectionEvents> {
	readonly electedClientId: string | undefined;
	readonly electedParentId: string | undefined;
}

/**
 * Determines the elected parent (oldest eligible interactive client) by reading quorum members.
 * Observes quorum membership events to detect when summarizer clients join or leave, enabling the
 * graceful handoff protocol. Monitors ops and logs telemetry when the elected client has not
 * produced a summary ack within a configured number of ops.
 *
 * This class tracks electedParent and electedClient separately. This
 * allows us to handle the case where a new interactive parent client has been elected, but the
 * summarizer is still doing work, so a new summarizer should not yet be spawned. In this case,
 * changing electedParent will cause SummaryManager to stop the current summarizer, but a new
 * summarizer will not be spawned until the old summarizer client has left the quorum.
 *
 * Details:
 *
 * electedParent is the interactive client that has been elected to spawn a summarizer. It is
 * typically the oldest eligible interactive client in the quorum. Only the electedParent is
 * permitted to spawn a summarizer.
 *
 * electedClient is the non-interactive summarizer client if one exists. If not, then
 * electedClient is equal to electedParent. If electedParent === electedClient, this is the
 * signal for electedParent to spawn a new electedClient. Once a summarizer client becomes
 * electedClient, a new summarizer will not be spawned until electedClient leaves the quorum.
 *
 * A typical sequence looks like this:
 *
 * i. Begin by electing A. electedParent === A, electedClient === A.
 *
 * ii. SummaryManager running on A spawns a summarizer client, A'. electedParent === A, electedClient === A'
 *
 * iii. A leaves the quorum. A new parent client, B, is elected. electedParent === B, electedClient === A'
 *
 * iv. SummaryManager running on A detects the change to electedParent and tells the summarizer to stop, but A'
 * is in mid-summarization. No new summarizer is spawned, as electedParent !== electedClient.
 *
 * v. A' completes its summary, and the summarizer and backing client are torn down.
 *
 * vi. A' leaves the quorum, and B takes its place as electedClient. electedParent === B, electedClient === B
 *
 * vii. SummaryManager running on B spawns a summarizer client, B'. electedParent === B, electedClient === B'
 */
export class SummarizerClientElection
	extends TypedEventEmitter<ISummarizerClientElectionEvents>
	implements ISummarizerClientElection
{
	private _electedParentId: string | undefined;
	/** Join sequence number of the elected parent, used for wrap-around election. */
	private _electedParentSeq: number | undefined;
	private _electedClientId: string | undefined;
	private _electionSequenceNumber: number;
	/**
	 * Used to calculate number of ops since last summary ack for the current elected client.
	 * This will be undefined if there is no elected summarizer, or no summary ack has been
	 * observed since this client was elected.
	 * When a summary ack comes in, this will be set to the sequence number of the summary ack.
	 */
	private lastSummaryAckSeqForClient: number | undefined;
	/**
	 * Used to prevent excess logging by recording the sequence number that we last reported at,
	 * and making sure we don't report another event to telemetry. If things work as intended,
	 * this is not needed, otherwise it could report an event on every op in worst case scenario.
	 */
	private lastReportedSeq = 0;

	private readonly logger: TelemetryLoggerExt;

	public get electedClientId(): string | undefined {
		return this._electedClientId;
	}

	public get electedParentId(): string | undefined {
		return this._electedParentId;
	}

	constructor(
		logger: ITelemetryBaseLogger,
		deltaManager: Pick<IDeltaManager<unknown, unknown>, "lastSequenceNumber">,
		private readonly quorum: Pick<IQuorumClients, "getMembers" | "on">,
		private readonly summaryCollection: IEventProvider<ISummaryCollectionOpEvents>,
		private readonly maxOpsSinceLastSummary: number,
		initialState: ISerializedElection | number,
	) {
		super();
		this.logger = createChildLogger({ logger, namespace: "SummarizerClientElection" });

		if (typeof initialState === "number") {
			this._electionSequenceNumber = initialState;
			this.setElectedParent(this.findOldestEligibleParent());
			this._electedClientId = this.findSummarizerInQuorum() ?? this._electedParentId;
		} else {
			this._electionSequenceNumber = initialState.electionSequenceNumber;
			this.initFromSerializedState(initialState);
		}
		quorum.on("addMember", (clientId: string, client: ISequencedClient) => {
			const sequenceNumber = deltaManager.lastSequenceNumber;
			if (!isClientEligible(client)) {
				return;
			}
			const isSummarizer = client.client.details.type === summarizerClientType;
			const electedClientIsSummarizer =
				this.electedClientId !== undefined && this.electedClientId !== this.electedParentId;
			if (this.electedClientId === undefined || (isSummarizer && !electedClientIsSummarizer)) {
				this.updateElection(
					clientId,
					isSummarizer ? this.electedParentId : clientId,
					sequenceNumber,
				);
			} else if (this.electedParentId === undefined && !isSummarizer) {
				this.updateElection(this.electedClientId, clientId, sequenceNumber);
			}
		});

		quorum.on("removeMember", (clientId: string) => {
			const sequenceNumber = deltaManager.lastSequenceNumber;

			if (clientId === this.electedClientId) {
				const parentId =
					clientId === this.electedParentId
						? this.findNextEligibleParent()
						: this.electedParentId;
				this.updateElection(parentId, parentId, sequenceNumber);
			} else if (clientId === this.electedParentId) {
				this.updateElection(
					this.electedClientId,
					this.findNextEligibleParent(),
					sequenceNumber,
				);
			}
		});

		// Op monitoring: recover if no client is elected but eligible clients exist
		this.summaryCollection.on("default", ({ sequenceNumber }) => {
			if (this.electedClientId === undefined) {
				this.resetElectedClient(sequenceNumber);
				return;
			}

			const baseline = this.lastSummaryAckSeqForClient ?? this._electionSequenceNumber;
			const opsWithoutSummary = sequenceNumber - baseline;
			if (opsWithoutSummary > this.maxOpsSinceLastSummary) {
				const opsSinceLastReport = sequenceNumber - this.lastReportedSeq;
				if (opsSinceLastReport > this.maxOpsSinceLastSummary) {
					this.logger.sendTelemetryEvent({
						eventName: "ElectedClientNotSummarizing",
						electedClientId: this.electedClientId,
						lastSummaryAckSeqForClient: this.lastSummaryAckSeqForClient,
						electionSequenceNumber: this._electionSequenceNumber,
						nextElectedClientId: this.findNextEligibleParent(),
						opsWithoutSummary,
					});
					this.lastReportedSeq = sequenceNumber;
				}
			}
		});

		// Summary ack resets the op counter
		this.summaryCollection.on(MessageType.SummaryAck, (op) => {
			this.lastSummaryAckSeqForClient = op.sequenceNumber;
		});
	}

	/**
	 * Initialize from serialized state, validating the elected parent is still in quorum.
	 */
	private initFromSerializedState(state: ISerializedElection): void {
		const members = this.quorum.getMembers();

		// Try to restore the elected parent directly
		if (state.electedParentId !== undefined) {
			const parentMember = members.get(state.electedParentId);
			if (parentMember !== undefined && isClientEligible(parentMember)) {
				this.setElectedParent(state.electedParentId);
			}
		}

		if (state.electedClientId === undefined) {
			// Serialized state explicitly indicates no one is elected.
			// Leave as undefined — the op handler will recover if needed.
			return;
		}

		const member = members.get(state.electedClientId);
		if (member === undefined) {
			// Leave the elected client undefined so the next op can recover from quorum.
			this.logger.sendErrorEvent({
				eventName: "InitialElectedClientNotFound",
				electionSequenceNumber: state.electionSequenceNumber,
				expectedClientId: state.electedClientId,
				electedClientId: undefined,
				clientCount: members.size,
			});
		} else if (isClientEligible(member)) {
			this._electedClientId = state.electedClientId;
			if (
				this.electedParentId === undefined &&
				member.client.details.type !== summarizerClientType
			) {
				this.setElectedParent(state.electedClientId);
			}
		} else {
			// The elected client is in quorum but ineligible — log an error
			// and elect the next eligible client after it.
			const fallbackId = this.findNextEligibleParentAfter(member.sequenceNumber);
			this.logger.sendErrorEvent({
				eventName: "InitialElectedClientIneligible",
				electionSequenceNumber: state.electionSequenceNumber,
				expectedClientId: state.electedClientId,
				electedClientId: fallbackId,
			});
			this.setElectedParent(fallbackId);
			this._electedClientId = fallbackId;
		}
	}

	/**
	 * Applies an election transition while preserving the elected-client sequence baseline.
	 * Parent-only changes reset the summary-ack baseline without changing that sequence number.
	 */
	private updateElection(
		clientId: string | undefined,
		parentId: string | undefined,
		sequenceNumber: number,
	): void {
		if (clientId === this.electedClientId && parentId === this.electedParentId) {
			return;
		}
		if (clientId !== this.electedClientId) {
			this._electionSequenceNumber = sequenceNumber;
		}
		this._electedClientId = clientId;
		this.setElectedParent(parentId);
		this.lastSummaryAckSeqForClient = undefined;
		if (clientId === undefined) {
			this.resetElectedClient(sequenceNumber);
		}
		this.emit("electedSummarizerChanged");
	}

	/**
	 * Resets the parent to the oldest eligible interactive client, retaining an elected summarizer.
	 */
	public resetElectedClient(sequenceNumber: number): void {
		const parentId = this.findOldestEligibleParent();
		this.updateElection(
			this.electedClientId === undefined || this.electedClientId === this.electedParentId
				? parentId
				: this.electedClientId,
			parentId,
			sequenceNumber,
		);
	}

	/**
	 * Sets the elected parent and tracks its join sequence number for wrap-around election.
	 */
	private setElectedParent(clientId: string | undefined): void {
		this._electedParentId = clientId;
		if (clientId === undefined) {
			this._electedParentSeq = undefined;
		} else {
			const member = this.quorum.getMembers().get(clientId);
			this._electedParentSeq = member?.sequenceNumber;
		}
	}

	/**
	 * Find the oldest eligible interactive (non-summarizer) client in the quorum.
	 * @returns the client id of the oldest eligible parent, or undefined if none are eligible.
	 */
	private findOldestEligibleParent(): string | undefined {
		return this.findNextEligibleParentAfter(-1);
	}

	/**
	 * Find the next eligible parent after the current one, wrapping around to
	 * the oldest if no younger client is found.
	 * @returns the client id of the next eligible parent, or undefined if none are eligible.
	 */
	private findNextEligibleParent(): string | undefined {
		const currentParentSeq = this._electedParentSeq ?? -1;
		return (
			this.findNextEligibleParentAfter(currentParentSeq) ?? this.findOldestEligibleParent()
		);
	}

	/**
	 * Find the next eligible interactive client after the given sequence number.
	 * @param sequenceNumber - sequence number to start searching after.
	 * @returns the client id of the next eligible parent, or undefined if none are found
	 * with a higher sequence number.
	 */
	private findNextEligibleParentAfter(sequenceNumber: number): string | undefined {
		let nextId: string | undefined;
		let nextSeq = Number.POSITIVE_INFINITY;

		for (const [clientId, client] of this.quorum.getMembers()) {
			if (
				isClientEligible(client) &&
				client.client.details.type !== summarizerClientType &&
				client.sequenceNumber > sequenceNumber &&
				client.sequenceNumber < nextSeq
			) {
				nextId = clientId;
				nextSeq = client.sequenceNumber;
			}
		}
		return nextId;
	}

	/**
	 * Find any summarizer-type client currently in the quorum.
	 */
	private findSummarizerInQuorum(): string | undefined {
		let oldestId: string | undefined;
		let oldestSequenceNumber = Number.POSITIVE_INFINITY;
		for (const [clientId, client] of this.quorum.getMembers()) {
			if (
				client.client.details.type === summarizerClientType &&
				client.sequenceNumber < oldestSequenceNumber
			) {
				oldestId = clientId;
				oldestSequenceNumber = client.sequenceNumber;
			}
		}
		return oldestId;
	}

	public serialize(): ISerializedElection {
		return {
			electionSequenceNumber: this.lastSummaryAckSeqForClient ?? this._electionSequenceNumber,
			electedClientId: this.electedClientId,
			electedParentId: this._electedParentId,
		};
	}

	public static readonly clientDetailsPermitElection = (details: IClientDetails): boolean =>
		details.capabilities.interactive || details.type === summarizerClientType;
}
