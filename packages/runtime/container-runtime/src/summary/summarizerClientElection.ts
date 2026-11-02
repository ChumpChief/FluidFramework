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
import type { IClientDetails, IQuorumClients } from "@fluidframework/driver-definitions";
import { MessageType } from "@fluidframework/driver-definitions/internal";
import { createChildLogger } from "@fluidframework/telemetry-utils/internal";

import { summarizerClientType } from "./summarizerTypes.js";
import type { ISummaryCollectionOpEvents } from "./summaryCollection.js";

/**
 * Persisted summary-progress baseline.
 * @internal
 */
export interface ISerializedElection {
	readonly electionSequenceNumber: number;
	/** Quorum-derived compatibility fields; retain until supported readers no longer require identities. */
	readonly electedClientId: string | undefined;
	readonly electedParentId: string | undefined;
}

export interface ISummarizerClientElectionEvents extends IEvent {
	(event: "electedSummarizerChanged", handler: () => void): void;
}

export interface ISummarizerClientElection
	extends IEventProvider<ISummarizerClientElectionEvents> {
	readonly electedParentId: string | undefined;
	readonly hasSummarizer: boolean;
}

/**
 * Elects the oldest eligible interactive quorum member to own automatic summarization.
 * The parent may create a child only when no summarizer clients are present in quorum.
 * An existing child continues under its owner's management until stopped or disconnected.
 *
 * When the parent leaves, the oldest remaining eligible interactive client becomes parent.
 * It waits for all existing summarizers to leave quorum before creating a replacement.
 * Each child's creator owns its cleanup, including manual/on-demand children. Any connected
 * summarizer, even an idle one, blocks replacement until its sequenced quorum departure.
 * Summary-progress telemetry uses an op baseline retained across snapshot loads.
 */
export class SummarizerClientElection
	extends TypedEventEmitter<ISummarizerClientElectionEvents>
	implements ISummarizerClientElection
{
	private _electedParentId: string | undefined;
	private _hasSummarizer = false;
	private progressSequenceNumber: number;
	private lastReportedSequenceNumber = 0;

	public get electedParentId(): string | undefined {
		return this._electedParentId;
	}

	public get hasSummarizer(): boolean {
		return this._hasSummarizer;
	}

	constructor(
		logger: ITelemetryBaseLogger,
		deltaManager: Pick<IDeltaManager<unknown, unknown>, "lastSequenceNumber">,
		private readonly quorum: Pick<IQuorumClients, "getMembers" | "on">,
		summaryCollection: IEventProvider<ISummaryCollectionOpEvents>,
		maxOpsSinceLastSummary: number,
		initialState: Pick<ISerializedElection, "electionSequenceNumber"> | number,
	) {
		super();
		const childLogger = createChildLogger({ logger, namespace: "SummarizerClientElection" });
		this.progressSequenceNumber =
			typeof initialState === "number" ? initialState : initialState.electionSequenceNumber;
		this.readQuorum();
		const refresh = (): void => {
			const parentId = this.electedParentId;
			const hasSummarizer = this.hasSummarizer;
			this.readQuorum();
			if (parentId !== this.electedParentId || hasSummarizer !== this.hasSummarizer) {
				// Parent succession while children remain does not represent summary progress.
				if (!hasSummarizer || !this.hasSummarizer) {
					this.progressSequenceNumber = deltaManager.lastSequenceNumber;
				}
				childLogger.sendTelemetryEvent({
					eventName: "ElectionChanged",
					previousElectedParentId: parentId,
					electedParentId: this.electedParentId,
					previousHasSummarizer: hasSummarizer,
					hasSummarizer: this.hasSummarizer,
					sequenceNumber: deltaManager.lastSequenceNumber,
				});
				this.emit("electedSummarizerChanged");
			}
		};
		quorum.on("addMember", refresh);
		quorum.on("removeMember", refresh);
		summaryCollection.on("default", ({ sequenceNumber }) => {
			if (this.electedParentId === undefined && !this.hasSummarizer) {
				return;
			}
			const opsWithoutSummary = sequenceNumber - this.progressSequenceNumber;
			if (
				opsWithoutSummary > maxOpsSinceLastSummary &&
				sequenceNumber - this.lastReportedSequenceNumber > maxOpsSinceLastSummary
			) {
				childLogger.sendTelemetryEvent({
					eventName: "ElectedClientNotSummarizing",
					electedParentId: this.electedParentId,
					hasSummarizer: this.hasSummarizer,
					electionSequenceNumber: this.progressSequenceNumber,
					opsWithoutSummary,
				});
				this.lastReportedSequenceNumber = sequenceNumber;
			}
		});
		summaryCollection.on(MessageType.SummaryAck, (op) => {
			this.progressSequenceNumber = op.sequenceNumber;
		});
	}

	private readQuorum(): void {
		let parentId: string | undefined;
		let parentSequenceNumber = Number.POSITIVE_INFINITY;
		let hasSummarizer = false;
		for (const [clientId, member] of this.quorum.getMembers()) {
			const details = member.client.details;
			if (details?.type === summarizerClientType) {
				hasSummarizer = true;
			} else if (
				(details === undefined || details.capabilities.interactive) &&
				member.sequenceNumber < parentSequenceNumber
			) {
				parentId = clientId;
				parentSequenceNumber = member.sequenceNumber;
			}
		}
		this._electedParentId = parentId;
		this._hasSummarizer = hasSummarizer;
	}

	public serialize(): ISerializedElection {
		// Older readers require an elected identity to retain their creation gate on load.
		// This representative is derived only for compatibility, not used for election decisions.
		let summarizerId: string | undefined;
		let sequenceNumber = Number.POSITIVE_INFINITY;
		for (const [id, member] of this.quorum.getMembers()) {
			if (
				member.client.details?.type === summarizerClientType &&
				member.sequenceNumber < sequenceNumber
			) {
				summarizerId = id;
				sequenceNumber = member.sequenceNumber;
			}
		}
		return {
			electionSequenceNumber: this.progressSequenceNumber,
			electedClientId: summarizerId ?? this.electedParentId,
			electedParentId: this.electedParentId,
		};
	}

	public static readonly clientDetailsPermitElection = (details: IClientDetails): boolean =>
		details.capabilities.interactive || details.type === summarizerClientType;
}
