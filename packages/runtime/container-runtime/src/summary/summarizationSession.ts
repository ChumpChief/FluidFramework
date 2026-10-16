/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { SummarizerStopReason } from "@fluidframework/container-runtime-definitions/internal";
import { Deferred } from "@fluidframework/core-utils/internal";

import type { ISummarizer } from "./summarizerTypes.js";

/**
 * Owns a summarizer from the beginning of asynchronous creation through closure.
 * Stop requests during creation are delivered when the summarizer becomes available.
 * Closing cannot cancel the underlying load, but closes a late result without running it.
 */
export class SummarizationSession {
	private readonly closeDeferred = new Deferred<undefined>();
	private closed = false;
	private stopReason: SummarizerStopReason | undefined;
	private ownedSummarizer: ISummarizer | undefined;

	/**
	 * Resolves when the summarizer object is loaded, or with undefined if the session closes first.
	 * Loading does not imply connection or executor readiness; those remain part of run().
	 */
	public readonly loaded: Promise<ISummarizer | undefined>;

	public get summarizer(): ISummarizer | undefined {
		return this.ownedSummarizer;
	}

	constructor(createSummarizer: () => Promise<ISummarizer>) {
		// Defer creation so the caller can retain the session before loading emits quorum events.
		const creation = Promise.resolve().then(async () => {
			const summarizer = await createSummarizer();
			if (this.closed) {
				summarizer.close();
				return undefined;
			}
			this.ownedSummarizer = summarizer;
			if (this.stopReason !== undefined) {
				summarizer.stop(this.stopReason);
			}
			return summarizer;
		});
		// The race also observes a creation failure after closure, when nobody is awaiting the load.
		this.loaded = Promise.race([creation, this.closeDeferred.promise]);
	}

	/**
	 * Runs the existing summarizer lifecycle and releases ownership when it finishes or fails.
	 */
	public async run(onBehalfOf: string): Promise<SummarizerStopReason | undefined> {
		try {
			const summarizer = this.ownedSummarizer ?? (await this.loaded);
			if (this.closed || summarizer === undefined) {
				return undefined;
			}
			return await summarizer.run(onBehalfOf);
		} finally {
			this.close();
		}
	}

	/**
	 * Requests graceful stopping, preserving the first reason even if loading is still in progress.
	 * The existing summarizer decides whether to finish work or attempt a last summary.
	 */
	public stop(reason: SummarizerStopReason): void {
		if (this.closed || this.stopReason !== undefined) {
			return;
		}
		this.stopReason = reason;
		this.ownedSummarizer?.stop(reason);
	}

	/**
	 * Abandons the session and closes its summarizer, including a result that arrives after closure.
	 */
	public close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const summarizer = this.ownedSummarizer;
		this.ownedSummarizer = undefined;
		this.closeDeferred.resolve(undefined);
		summarizer?.close();
	}
}
