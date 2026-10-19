/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { createEmitter } from "@fluid-internal/client-utils";
import type { Listenable } from "@fluidframework/core-interfaces/internal";
import type { IQuorumClients } from "@fluidframework/driver-definitions";

import { summarizerClientType } from "./summarizerTypes.js";

export interface ISummarizerClientElectionEvents {
	electedSummarizerChanged: () => void;
}

export interface ISummarizerClientElection {
	readonly events: Listenable<ISummarizerClientElectionEvents>;
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
 */
export class SummarizerClientElection implements ISummarizerClientElection {
	private readonly emitter = createEmitter<ISummarizerClientElectionEvents>();
	public get events(): Listenable<ISummarizerClientElectionEvents> {
		return this.emitter;
	}
	private _electedParentId: string | undefined;
	private _hasSummarizer = false;

	public get electedParentId(): string | undefined {
		return this._electedParentId;
	}

	public get hasSummarizer(): boolean {
		return this._hasSummarizer;
	}

	constructor(private readonly quorum: Pick<IQuorumClients, "getMembers" | "on">) {
		this.refresh();
		quorum.on("addMember", this.refresh);
		quorum.on("removeMember", this.refresh);
	}

	private readonly refresh = (): void => {
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
		if (parentId !== this._electedParentId || hasSummarizer !== this._hasSummarizer) {
			this._electedParentId = parentId;
			this._hasSummarizer = hasSummarizer;
			this.emitter.emit("electedSummarizerChanged");
		}
	};
}
