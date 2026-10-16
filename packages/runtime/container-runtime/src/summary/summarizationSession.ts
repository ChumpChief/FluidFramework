/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { SummarizerStopReason } from "@fluidframework/container-runtime-definitions/internal";
import { Deferred } from "@fluidframework/core-utils/internal";

import type { ISummarizer } from "./summarizerTypes.js";

const stopTimeoutMs = 2 * 60 * 1000;

/** The terminal outcome of the locally owned session, not a quorum departure notification. */
export type SummarizationSessionOutcome =
	| { readonly kind: "completed"; readonly reason: SummarizerStopReason }
	| { readonly kind: "closed" }
	| { readonly kind: "timeout"; readonly reason: SummarizerStopReason }
	| { readonly kind: "failed"; readonly error: unknown };

/**
 * Owns a summarizer from the beginning of asynchronous creation through closure.
 * Stop requests during creation are delivered when the summarizer becomes available.
 * Closing cannot cancel the underlying load, but closes a late result without running it.
 */
export class SummarizationSession {
	private readonly closeDeferred = new Deferred<undefined>();
	private readonly completion = new Deferred<SummarizationSessionOutcome>();
	private isClosed = false;
	private stopTimer: ReturnType<typeof setTimeout> | undefined;
	private stopReason: SummarizerStopReason | undefined;
	private ownedSummarizer: ISummarizer | undefined;

	/**
	 * Resolves when the summarizer object is loaded, or with undefined if the session closes first.
	 * Loading does not imply connection or executor readiness; those remain part of run().
	 */
	public readonly loaded: Promise<ISummarizer | undefined>;

	/** Settles once local ownership ends, even when an underlying load or run is still pending. */
	public readonly closed = this.completion.promise;

	public get summarizer(): ISummarizer | undefined {
		return this.ownedSummarizer;
	}

	constructor(createSummarizer: () => Promise<ISummarizer>) {
		// Defer creation so the caller can retain the session before loading emits quorum events.
		const creation = Promise.resolve().then(async () => {
			const summarizer = await createSummarizer();
			if (this.isClosed) {
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
		// eslint-disable-next-line no-void
		void this.loaded.catch((error: unknown) => {
			this.finish({ kind: "failed", error });
		});
	}

	/**
	 * Runs the existing summarizer lifecycle and releases ownership when it finishes or fails.
	 */
	public async run(onBehalfOf: string): Promise<SummarizerStopReason | undefined> {
		try {
			const summarizer = this.ownedSummarizer ?? (await this.loaded);
			if (this.isClosed || summarizer === undefined) {
				return undefined;
			}
			const result = await Promise.race([
				summarizer.run(onBehalfOf),
				this.closeDeferred.promise,
			]);
			if (result !== undefined) {
				this.finish({ kind: "completed", reason: result });
			}
			return result;
		} catch (error) {
			this.finish({ kind: "failed", error });
			throw error;
		}
	}

	/**
	 * Requests graceful stopping, preserving the first reason even if loading is still in progress.
	 * The existing summarizer decides whether to finish work or attempt a last summary.
	 */
	public stop(reason: SummarizerStopReason): void {
		if (this.isClosed || this.stopReason !== undefined) {
			return;
		}
		this.stopReason = reason;
		this.stopTimer = setTimeout(() => {
			this.finish({ kind: "timeout", reason });
		}, stopTimeoutMs);
		this.ownedSummarizer?.stop(reason);
	}

	/**
	 * Abandons the session and closes its summarizer, including a result that arrives after closure.
	 */
	public close(): void {
		this.finish({ kind: "closed" });
	}

	private finish(outcome: SummarizationSessionOutcome): void {
		if (this.isClosed) {
			return;
		}
		this.isClosed = true;
		if (this.stopTimer !== undefined) {
			clearTimeout(this.stopTimer);
			this.stopTimer = undefined;
		}
		const summarizer = this.ownedSummarizer;
		this.ownedSummarizer = undefined;
		this.closeDeferred.resolve(undefined);
		try {
			summarizer?.close();
		} finally {
			this.completion.resolve(outcome);
		}
	}
}
