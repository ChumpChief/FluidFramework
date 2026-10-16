/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type {
	ISummarizerEvents,
	SummarizerStopReason,
} from "@fluidframework/container-runtime-definitions/internal";
import { Deferred } from "@fluidframework/core-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";

import type { ISummarizer } from "./summarizerTypes.js";

const stopTimeoutMs = 2 * 60 * 1000;

/** Readiness is distinct from loading, and older children cannot report executor readiness. */
export type SummarizationSessionReadiness =
	| { readonly kind: "ready" }
	| { readonly kind: "legacy-loaded" }
	| { readonly kind: "closed" }
	| { readonly kind: "failed"; readonly error: unknown };

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
export class SummarizationSession extends TypedEventEmitter<ISummarizerEvents> {
	private readonly closeDeferred = new Deferred<undefined>();
	private readonly completion = new Deferred<SummarizationSessionOutcome>();
	private readonly loadAbortController = new AbortController();
	private isClosed = false;
	private stopTimer: ReturnType<typeof setTimeout> | undefined;
	private stopReason: SummarizerStopReason | undefined;
	private started = false;
	private ownedSummarizer: ISummarizer | undefined;
	private readonly removeForwardedEvents: (() => void)[] = [];

	/**
	 * Resolves to true when the summarizer is loaded, or false if the session closes first.
	 * Loading does not imply connection or executor readiness; those remain part of run().
	 */
	public readonly loaded: Promise<boolean>;

	/**
	 * Reports executor readiness once run or an explicit request starts the child lifecycle.
	 * Legacy children report only that loading completed; this never starts execution itself.
	 */
	public readonly ready: Promise<SummarizationSessionReadiness>;

	/** Settles once local ownership ends, even when an underlying load or run is still pending. */
	public readonly closed = this.completion.promise;

	public get isLoaded(): boolean {
		return this.ownedSummarizer !== undefined;
	}

	public get isStopping(): boolean {
		return this.stopReason !== undefined;
	}

	constructor(createSummarizer: (signal?: AbortSignal) => Promise<ISummarizer>) {
		super();
		// Defer creation so the caller can retain the session before loading emits quorum events.
		const creation = Promise.resolve().then(async () => {
			const summarizer = await createSummarizer(this.loadAbortController.signal);
			if (this.isClosed) {
				summarizer.close();
				return false;
			}
			this.ownedSummarizer = summarizer;
			this.forwardEvents(summarizer);
			if (this.stopReason !== undefined) {
				summarizer.stop(this.stopReason);
			}
			return true;
		});
		// The race also observes a creation failure after closure, when nobody is awaiting the load.
		this.loaded = Promise.race([creation, this.closeDeferred.promise.then(() => false)]);
		// eslint-disable-next-line no-void
		void this.loaded.catch((error: unknown) => {
			this.finish({ kind: "failed", error });
		});
		const readiness = this.loaded.then(
			async (loaded): Promise<SummarizationSessionReadiness> => {
				if (!loaded || this.isClosed) {
					return { kind: "closed" };
				}
				const child = this.getSummarizer() as ISummarizer & {
					waitUntilReady?: () => Promise<void>;
				};
				if (child.waitUntilReady === undefined) {
					return { kind: "legacy-loaded" };
				}
				await child.waitUntilReady();
				return { kind: "ready" };
			},
		);
		this.ready = Promise.race([
			readiness,
			this.closed.then(
				(outcome): SummarizationSessionReadiness =>
					outcome.kind === "failed" ? outcome : { kind: "closed" },
			),
		]).catch((error: unknown): SummarizationSessionReadiness => ({ kind: "failed", error }));
	}

	/**
	 * Starts the owned lifecycle once. All callers observe its terminal outcome through closed.
	 */
	public start(onBehalfOf: string): void {
		if (this.started || this.isClosed) {
			return;
		}
		this.started = true;
		// Execution failures become terminal outcomes, not a second rejecting completion promise.
		// eslint-disable-next-line no-void
		void this.execute(onBehalfOf);
	}

	private async execute(onBehalfOf: string): Promise<void> {
		try {
			if (!this.isLoaded) {
				await this.loaded;
			}
			const summarizer = this.ownedSummarizer;
			if (this.isClosed || summarizer === undefined) {
				return;
			}
			const result = await Promise.race([
				summarizer.run(onBehalfOf),
				this.closeDeferred.promise,
			]);
			if (result !== undefined) {
				this.finish({ kind: "completed", reason: result });
			}
		} catch (error) {
			this.finish({ kind: "failed", error });
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

	/** Requests a summary from the loaded child using its existing execution policy. */
	public summarizeOnDemand(
		...args: Parameters<ISummarizer["summarizeOnDemand"]>
	): ReturnType<ISummarizer["summarizeOnDemand"]> {
		return this.getSummarizer().summarizeOnDemand(...args);
	}

	/** Enqueues a summary in the loaded child's existing execution queue. */
	public enqueueSummarize(
		...args: Parameters<ISummarizer["enqueueSummarize"]>
	): ReturnType<ISummarizer["enqueueSummarize"]> {
		return this.getSummarizer().enqueueSummarize(...args);
	}

	private getSummarizer(): ISummarizer {
		if (this.ownedSummarizer === undefined) {
			throw new UsageError("The summarization session is not loaded or has closed.");
		}
		return this.ownedSummarizer;
	}

	private forwardEvents(summarizer: ISummarizer): void {
		for (const event of [
			"summarize",
			"summarizeAllAttemptsFailed",
			"summarizerStop",
			"summarizerStart",
			"summarizerStartupFailed",
			"summarizeTimeout",
		] as const) {
			const listener = (...args: unknown[]): void => {
				this.emit(event, ...args);
			};
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
			summarizer.on(event as any, listener);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
			this.removeForwardedEvents.push(() => summarizer.off(event as any, listener));
		}
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
			this.loadAbortController.abort();
			for (const remove of this.removeForwardedEvents) {
				remove();
			}
			this.removeForwardedEvents.length = 0;
			this.removeAllListeners();
			this.completion.resolve(outcome);
		}
	}
}
