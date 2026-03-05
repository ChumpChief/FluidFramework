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
	type ITelemetryLoggerExt,
	createChildLogger,
} from "@fluidframework/telemetry-utils/internal";

import { summarizerClientType } from "./summarizerTypes.js";
import type { ISummaryCollectionOpEvents } from "./summaryCollection.js";

/**
 * Serialized state of the summarizer election.
 * @internal
 */
export interface ISerializedElection {
	readonly electionSequenceNumber: number;
	readonly electedClientId: string | undefined;
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
 * Simplified summarizer election that replaces OrderedClientCollection +
 * OrderedClientElection + SummarizerClientElection.
 *
 * Determines the elected parent (oldest eligible interactive client) by
 * iterating quorum members. Tracks summarizer clients in the quorum to
 * implement the graceful handoff protocol.
 */
export class SummarizerElection
	extends TypedEventEmitter<ISummarizerClientElectionEvents>
	implements ISummarizerClientElection
{
	private _electedParentId: string | undefined;
	private _summarizerClientId: string | undefined;
	private _electionSequenceNumber: number;
	private lastSummaryAckSeqForClient: number | undefined;
	private lastReportedSeq = 0;

	private readonly logger: ITelemetryLoggerExt;

	public get electedClientId(): string | undefined {
		return this._summarizerClientId ?? this._electedParentId;
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
		this.logger = createChildLogger({ logger, namespace: "SummarizerElection" });

		if (typeof initialState === "number") {
			this._electionSequenceNumber = initialState;
			this._electedParentId = this.findOldestEligibleParent();
		} else {
			this._electionSequenceNumber = initialState.electionSequenceNumber;
			this.initFromSerializedState(initialState);
		}
		// Initialize summarizer tracking from current quorum state
		this._summarizerClientId = this.findSummarizerInQuorum();

		quorum.on("addMember", (clientId: string, client: ISequencedClient) => {
			const sequenceNumber = deltaManager.lastSequenceNumber;
			const isSummarizer = client.client.details.type === summarizerClientType;

			if (isSummarizer) {
				this._summarizerClientId = clientId;
				this.emit("electedSummarizerChanged");
				return;
			}

			// Interactive client joined
			if (this._electedParentId === undefined && SummarizerElection.isClientEligible(client)) {
				this._electedParentId = clientId;
				this._electionSequenceNumber = sequenceNumber;
				this.lastSummaryAckSeqForClient = undefined;
				this.emit("electedSummarizerChanged");
			}
		});

		quorum.on("removeMember", (clientId: string) => {
			const sequenceNumber = deltaManager.lastSequenceNumber;

			if (clientId === this._electedParentId) {
				// The elected parent left — recompute.
				this._electedParentId = this.findOldestEligibleParent();
				this._electionSequenceNumber = sequenceNumber;
				this.lastSummaryAckSeqForClient = undefined;
				this.emit("electedSummarizerChanged");
				return;
			}

			if (clientId === this._summarizerClientId) {
				// The summarizer client left — electedClientId reverts to parent.
				this._summarizerClientId = undefined;
				this.emit("electedSummarizerChanged");
			}
		});

		// Op monitoring: recover if no client is elected but eligible clients exist
		this.summaryCollection.on("default", ({ sequenceNumber }) => {
			if (this.electedClientId === undefined) {
				if (this.hasEligibleClients()) {
					this._electedParentId = this.findOldestEligibleParent();
					if (this._electedParentId !== undefined) {
						this._electionSequenceNumber = sequenceNumber;
						this.lastSummaryAckSeqForClient = undefined;
						this.emit("electedSummarizerChanged");
					}
				}
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

		// Try to restore the elected parent
		if (state.electedParentId !== undefined) {
			const member = members.get(state.electedParentId);
			if (member !== undefined && SummarizerElection.isClientEligible(member)) {
				this._electedParentId = state.electedParentId;
				return;
			}
		}

		// If electedParentId is missing but electedClientId is an interactive client, use it
		if (state.electedClientId !== undefined && state.electedParentId === undefined) {
			const member = members.get(state.electedClientId);
			if (
				member !== undefined &&
				SummarizerElection.isClientEligible(member) &&
				member.client.details.type !== summarizerClientType
			) {
				this._electedParentId = state.electedClientId;
				return;
			}
		}

		if (state.electedClientId === undefined) {
			// Serialized state explicitly indicates no one is elected.
			// Leave as undefined — the op handler will recover if needed.
			return;
		}

		// The elected client was specified but not found in quorum — log an error
		// and fall back to computing from quorum.
		if (!members.has(state.electedClientId)) {
			this.logger.sendErrorEvent({
				eventName: "InitialElectedClientNotFound",
				electionSequenceNumber: state.electionSequenceNumber,
				expectedClientId: state.electedClientId,
				electedClientId: undefined,
				clientCount: members.size,
			});
		}

		this._electedParentId = this.findOldestEligibleParent();
	}

	/**
	 * Find the oldest eligible interactive (non-summarizer) client in the quorum.
	 */
	private findOldestEligibleParent(): string | undefined {
		let oldestId: string | undefined;
		let oldestSeq = Number.MAX_SAFE_INTEGER;

		for (const [clientId, client] of this.quorum.getMembers()) {
			if (
				SummarizerElection.isClientEligible(client) &&
				client.client.details.type !== summarizerClientType &&
				client.sequenceNumber < oldestSeq
			) {
				oldestId = clientId;
				oldestSeq = client.sequenceNumber;
			}
		}
		return oldestId;
	}

	/**
	 * Find any summarizer-type client currently in the quorum.
	 */
	private findSummarizerInQuorum(): string | undefined {
		for (const [clientId, client] of this.quorum.getMembers()) {
			if (client.client.details.type === summarizerClientType) {
				return clientId;
			}
		}
		return undefined;
	}

	/**
	 * Check if there are any eligible interactive clients in the quorum.
	 */
	private hasEligibleClients(): boolean {
		for (const [, client] of this.quorum.getMembers()) {
			if (
				SummarizerElection.isClientEligible(client) &&
				client.client.details.type !== summarizerClientType
			) {
				return true;
			}
		}
		return false;
	}

	public serialize(): ISerializedElection {
		return {
			electionSequenceNumber: this.lastSummaryAckSeqForClient ?? this._electionSequenceNumber,
			electedClientId: this.electedClientId,
			electedParentId: this._electedParentId,
		};
	}

	private static isClientEligible(client: ISequencedClient): boolean {
		const details: IClient["details"] | undefined = client.client.details;
		if (details === undefined) {
			return true;
		}
		return SummarizerElection.clientDetailsPermitElection(details);
	}

	public static readonly clientDetailsPermitElection = (details: IClientDetails): boolean =>
		details.capabilities.interactive || details.type === summarizerClientType;
}
