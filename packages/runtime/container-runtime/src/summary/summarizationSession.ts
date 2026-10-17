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
import type { SummaryExecution, SummaryExecutionSource } from "./summaryExecution.js";

/** A startup milestone, explicitly distinguishing older children without executor readiness. */
export type SummarizationSessionReadiness =
	| { readonly kind: "ready" }
	| { readonly kind: "legacy-loaded" }
	| { readonly kind: "closed" }
	| { readonly kind: "failed"; readonly error: unknown };

/** Local ownership completion. Only quorum departure authorizes distributed replacement. */
export type SummarizationSessionOutcome =
	| { readonly kind: "completed"; readonly reason: SummarizerStopReason }
	| { readonly kind: "closed" }
	| { readonly kind: "timeout"; readonly reason: SummarizerStopReason }
	| { readonly kind: "failed"; readonly error: unknown };

/**
 * Owns loading, invocation, the overall drain deadline, and container disposal.
 * Child execution owns connection and executor startup, not another container lifecycle.
 */
export class SummarizationSession extends TypedEventEmitter<ISummarizerEvents> {
	private readonly completion = new Deferred<SummarizationSessionOutcome>();
	private readonly readiness = new Deferred<SummarizationSessionReadiness>();
	private readonly abort = new AbortController();
	private child: ISummarizer | undefined;
	private execution: SummaryExecution | undefined;
	private started = false;
	private finished = false;
	private stopReason: SummarizerStopReason | undefined;
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private readonly removeListeners: (() => void)[] = [];

	/** Loading is not executor readiness and does not start execution. */
	public readonly loaded: Promise<boolean>;
	public readonly ready = this.readiness.promise;
	public readonly closed = this.completion.promise;

	public get isLoaded(): boolean {
		return this.child !== undefined;
	}
	public get isStopping(): boolean {
		return this.stopReason !== undefined;
	}

	constructor(load: (signal?: AbortSignal) => Promise<ISummarizer>) {
		super();
		// The caller must receive ownership before loading can emit quorum events.
		const loading = Promise.resolve().then(async () => {
			const child = await load(this.abort.signal);
			if (this.finished) {
				child.close();
				return false;
			}
			this.child = child;
			this.forwardEvents(child);
			if (this.stopReason !== undefined) {
				child.stop(this.stopReason);
			}
			if (!("openSummaryExecution" in child)) {
				const legacy = child as ISummarizer & { waitUntilReady?: () => Promise<void> };
				if (legacy.waitUntilReady === undefined) {
					this.readiness.resolve({ kind: "legacy-loaded" });
				} else {
					this.observeReadiness(legacy.waitUntilReady());
				}
			}
			return true;
		});
		this.loaded = Promise.race([loading, this.closed.then(() => false)]);
		// Observe load errors even when no caller awaits the loading milestone.
		// eslint-disable-next-line no-void
		void loading.catch((error: unknown) => this.finish({ kind: "failed", error }));
	}

	/** Starts automatic execution once; completion is observed only through closed. */
	public start(onBehalfOf: string): void {
		this.begin(onBehalfOf, true);
	}

	private begin(onBehalfOf: string | undefined, allowLastSummary: boolean): void {
		if (this.started || this.finished) {
			return;
		}
		this.started = true;
		// eslint-disable-next-line no-void
		void this.execute(onBehalfOf, allowLastSummary);
	}

	private async execute(
		onBehalfOf: string | undefined,
		allowLastSummary: boolean,
	): Promise<void> {
		try {
			if (!this.child) {
				await this.loaded;
			}
			if (this.finished || this.child === undefined) {
				return;
			}
			const source = this.child as ISummarizer & Partial<SummaryExecutionSource>;
			this.execution = source.openSummaryExecution?.({ onBehalfOf, allowLastSummary });
			if (this.execution !== undefined) {
				this.observeReadiness(this.execution.ready);
				if (this.stopReason !== undefined) {
					this.execution.stop(this.stopReason);
				}
			}
			const reason = await (this.execution?.closed ?? this.child.run(onBehalfOf ?? ""));
			this.finish({ kind: "completed", reason });
		} catch (error) {
			this.finish({ kind: "failed", error });
		}
	}

	private observeReadiness(ready: Promise<void>): void {
		// eslint-disable-next-line no-void
		void ready.then(
			() => this.readiness.resolve({ kind: "ready" }),
			(error: unknown) => this.readiness.resolve({ kind: "failed", error }),
		);
	}

	/** Requests draining; the single session deadline includes loading and executor startup. */
	public stop(reason: SummarizerStopReason): void {
		if (this.finished || this.stopReason !== undefined) {
			return;
		}
		this.stopReason = reason;
		this.deadline = setTimeout(() => this.finish({ kind: "timeout", reason }), 2 * 60 * 1000);
		(this.execution ?? this.child)?.stop(reason);
	}

	/** Abandons work and releases the container; pending loader results are disposed on arrival. */
	public close(): void {
		this.finish({ kind: "closed" });
	}

	/** Accepts a job before loading and waits for a capable child's executor before dispatch. */
	public async requestSummary(
		...args: Parameters<ISummarizer["summarizeOnDemand"]>
	): Promise<ReturnType<ISummarizer["summarizeOnDemand"]>> {
		await this.loaded;
		this.prepareExplicitExecution();
		const ready = await this.ready;
		if (ready.kind === "failed") {
			throw ready.error;
		}
		return this.summarizeOnDemand(...args);
	}

	/** Compatibility facade for existing synchronous result/progress APIs. */
	public summarizeOnDemand(
		...args: Parameters<ISummarizer["summarizeOnDemand"]>
	): ReturnType<ISummarizer["summarizeOnDemand"]> {
		this.prepareExplicitExecution();
		return (this.execution ?? this.requireChild()).summarizeOnDemand(...args);
	}

	public enqueueSummarize(
		...args: Parameters<ISummarizer["enqueueSummarize"]>
	): ReturnType<ISummarizer["enqueueSummarize"]> {
		return (this.execution ?? this.requireChild()).enqueueSummarize(...args);
	}

	private prepareExplicitExecution(): void {
		if ("openSummaryExecution" in this.requireChild()) {
			this.begin(undefined, false);
		}
	}

	private requireChild(): ISummarizer {
		if (this.child === undefined) {
			throw new UsageError("The summarization session is not loaded or has closed.");
		}
		return this.child;
	}

	private forwardEvents(child: ISummarizer): void {
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
			child.on(event as any, listener);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
			this.removeListeners.push(() => child.off(event as any, listener));
		}
	}

	private finish(outcome: SummarizationSessionOutcome): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		clearTimeout(this.deadline);
		const child = this.child;
		this.child = undefined;
		this.execution = undefined;
		try {
			child?.close();
		} finally {
			this.abort.abort();
			for (const remove of this.removeListeners) {
				remove();
			}
			this.removeListeners.length = 0;
			this.removeAllListeners();
			this.readiness.resolve(outcome.kind === "failed" ? outcome : { kind: "closed" });
			this.completion.resolve(outcome);
		}
	}
}
