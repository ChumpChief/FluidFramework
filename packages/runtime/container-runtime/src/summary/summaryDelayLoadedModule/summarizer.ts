/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type {
	ISummarizerEvents,
	SummarizerStopReason,
} from "@fluidframework/container-runtime-definitions/internal";
import type { IFluidHandleContext } from "@fluidframework/core-interfaces/internal";
import {
	createChildLogger,
	type IFluidErrorBase,
	LoggingError,
	type TelemetryLoggerExt,
	UsageError,
	wrapErrorAndLog,
} from "@fluidframework/telemetry-utils/internal";

import type {
	ISummarizer,
	ISummarizerRuntime,
	ISummarizerInternalsProvider,
	ISummaryConfiguration,
	ISummarizingWarning,
	ISummarizeHeuristicData,
	IOnDemandSummarizeOptions,
	IEnqueueSummarizeOptions,
} from "../summarizerTypes.js";
import type { SummaryCollection } from "../summaryCollection.js";
import {
	type SummaryClient,
	type SummaryExecutionSource,
	untilAborted,
	waitForStop,
} from "../summaryExecution.js";
import { RunWhileConnectedCoordinator } from "./runWhileConnectedCoordinator.js";
import { RunningSummarizer } from "./runningSummarizer.js";
import { SummarizeHeuristicData } from "./summarizerHeuristics.js";
import { SummarizeResultBuilder } from "./summaryResultBuilder.js";
import type { ISummarizeResults, EnqueueSummarizeResult } from "./summaryResultTypes.js";

export const defaultMaxAttempts = 2;
export const defaultMaxAttemptsForSubmitFailures = 5;

export class SummarizingWarning
	extends LoggingError
	implements ISummarizingWarning, IFluidErrorBase
{
	readonly errorType = "summarizingError";
	readonly canRetry = true;
	constructor(
		errorMessage: string,
		readonly logged: boolean = false,
	) {
		super(errorMessage);
	}
	static wrap(
		error: unknown,
		logged: boolean = false,
		logger: TelemetryLoggerExt,
	): SummarizingWarning {
		return wrapErrorAndLog(
			error,
			(message) => new SummarizingWarning(message, logged),
			logger,
		);
	}
}
export const createSummarizingWarning = (
	message: string,
	logged: boolean,
): SummarizingWarning => new SummarizingWarning(message, logged);

/**
 * Connects a summary client and runs an awaited callback with its existing summary executor.
 * The callback's scope owns startup and cleanup; the outer caller owns the container.
 * @internal
 */
export class Summarizer
	extends TypedEventEmitter<ISummarizerEvents>
	implements ISummarizer, SummaryExecutionSource
{
	public get ISummarizer(): this {
		return this;
	}
	private readonly logger: TelemetryLoggerExt;
	private readonly disposed = new AbortController();
	private runningSummarizer: RunningSummarizer | undefined;
	private heuristicData: ISummarizeHeuristicData | undefined;
	private inUse = false;

	// Only the legacy synchronous progress API needs a background lifetime and shared startup.
	private readonly legacyStop = new AbortController();
	private legacyTask: Promise<SummarizerStopReason> | undefined;
	private legacyClient: Promise<RunningSummarizer> | undefined;
	private legacyConnection: RunWhileConnectedCoordinator | undefined;

	constructor(
		private readonly runtime: ISummarizerRuntime,
		private readonly configurationGetter: () => ISummaryConfiguration,
		private readonly internalsProvider: ISummarizerInternalsProvider,
		_handleContext: IFluidHandleContext,
		public readonly summaryCollection: SummaryCollection,
		private readonly active: () => boolean,
	) {
		super();
		this.logger = createChildLogger({ logger: runtime.baseLogger, namespace: "Summarizer" });
	}

	/** The direct path: connect, start, invoke, drain, and release in one call stack. */
	public async withSummarizer<T>(
		options: Parameters<SummaryExecutionSource["withSummarizer"]>[0],
		action: (client: SummaryClient) => Promise<T>,
	): Promise<T> {
		if (this.inUse) {
			throw new UsageError("This summary client is already owned by another invocation.");
		}
		this.inUse = true;
		const connection = RunWhileConnectedCoordinator.open(this.runtime, this.active);
		const abort = AbortSignal.any([options.abort, this.disposed.signal, connection.signal]);
		const cancel = (): void => connection.stop("summarizerClientDisconnected");
		abort.addEventListener("abort", cancel, { once: true });
		let reason: SummarizerStopReason = "summarizerException";
		let failure: unknown;
		try {
			abort.throwIfAborted();
			const executor = await this.connect(connection, options.onBehalfOf, abort);
			const result = await untilAborted(action(executor), abort);
			reason = options.stop.aborted
				? (options.stop.reason as SummarizerStopReason)
				: "notElectedParent";
			// Parent stop drains; child disconnect/abort cancels the existing executor token.
			if (options.drain !== false) {
				await untilAborted(
					executor.waitStop(
						!connection.cancelled &&
							options.allowLastSummary &&
							Summarizer.stopReasonCanRunLastSummary(reason),
					),
					abort,
				);
			}
			return result;
		} catch (error) {
			failure = error;
			reason = abort.aborted ? "summarizerClientDisconnected" : "summarizerException";
			throw error;
		} finally {
			this.emit("summarizerStop", { stopReason: reason, error: failure });
			abort.removeEventListener("abort", cancel);
			connection.stop(reason);
			this.releaseExecutor();
			this.inUse = false;
		}
	}

	private async connect(
		connection: RunWhileConnectedCoordinator,
		parent: string | undefined,
		abort: AbortSignal,
	): Promise<RunningSummarizer> {
		const connected = await untilAborted(connection.ready, abort);
		if (connected === "timeout") {
			this.logger.sendTelemetryEvent({
				eventName: "CreateRunCoordinatorTimeout",
				onBehalfOf: parent,
				timeoutMs: 2 * 60 * 1000,
			});
		}
		if (connected !== "connected" || connection.cancelled) {
			throw new UsageError("Summarizer disconnected before startup");
		}
		this.emit("summarizerStart", { onBehalfOf: parent ?? this.runtime.clientId });
		const starting = this.startExecutor(connection);
		// The connection token owns cancellation even when the injected/test controller is inert.
		const discardLate = async (): Promise<RunningSummarizer> => {
			const lateExecutor = await starting;
			if (abort.aborted) {
				lateExecutor.dispose();
				abort.throwIfAborted();
			}
			return lateExecutor;
		};
		const executor = await untilAborted(discardLate(), abort);
		this.runningSummarizer = executor;
		return executor;
	}

	private async startExecutor(
		connection: RunWhileConnectedCoordinator,
	): Promise<RunningSummarizer> {
		const clientId = this.runtime.clientId;
		if (clientId === undefined) {
			throw new UsageError("A connected summary client must have a client ID.");
		}
		this.heuristicData = new SummarizeHeuristicData(
			this.runtime.deltaManager.lastSequenceNumber,
			{
				refSequenceNumber: this.runtime.deltaManager.initialSequenceNumber,
				summaryTime: Date.now(),
			},
		);
		const executor = await RunningSummarizer.start(
			this.logger,
			this.summaryCollection.createWatcher(clientId),
			this.configurationGetter(),
			async (...args) => this.internalsProvider.submitSummary(...args),
			async (...args) => this.internalsProvider.refreshLatestSummaryAck(...args),
			this.heuristicData,
			this.summaryCollection,
			connection,
			(reason) => connection.stop(reason),
			this.runtime,
		);
		if (this.disposed.signal.aborted || connection.cancelled) {
			executor.dispose();
			throw new UsageError("Summary client closed during startup");
		}
		for (const event of [
			"summarize",
			"summarizeAllAttemptsFailed",
			"summarizeTimeout",
		] as const) {
			executor.on(event, (...args: unknown[]) => {
				this.emit(event, ...args);
			});
		}
		return executor;
	}

	private releaseExecutor(): void {
		this.runningSummarizer?.dispose();
		this.runningSummarizer = undefined;
	}

	/** Legacy lifetime adapter for callers that expect run/stop and synchronous progress promises. */
	public async run(onBehalfOf: string): Promise<SummarizerStopReason> {
		return this.startLegacy(onBehalfOf, true);
	}

	private async startLegacy(
		parent: string | undefined,
		allowLastSummary: boolean,
	): Promise<SummarizerStopReason> {
		if (this.legacyTask === undefined) {
			this.legacyConnection = RunWhileConnectedCoordinator.open(this.runtime, this.active);
			this.legacyClient = this.connect(this.legacyConnection, parent, this.disposed.signal);
			this.legacyTask = this.runLegacy(allowLastSummary);
			// One owned async root is required by the old synchronous summarizeOnDemand API.
			this.legacyTask.catch(() => {});
		}
		return this.legacyTask;
	}

	private async runLegacy(allowLastSummary: boolean): Promise<SummarizerStopReason> {
		const connection = this.legacyConnection;
		if (connection === undefined || this.legacyClient === undefined) {
			throw new UsageError("Legacy startup missing");
		}
		try {
			const executor = await this.legacyClient;
			const reason = await Promise.race([
				waitForStop(this.legacyStop.signal),
				connection.waitCancelled,
			]);
			const timeout = setTimeout(() => this.dispose(), 2 * 60 * 1000);
			try {
				await untilAborted(
					executor.waitStop(
						allowLastSummary &&
							!connection.cancelled &&
							Summarizer.stopReasonCanRunLastSummary(reason),
					),
					this.disposed.signal,
				);
			} finally {
				clearTimeout(timeout);
			}
			return reason;
		} finally {
			connection.stop("summarizerClientDisconnected");
			this.close();
		}
	}

	public stop(reason: SummarizerStopReason): void {
		if (!this.legacyStop.signal.aborted) {
			this.legacyStop.abort(reason);
		}
	}
	public close(): void {
		this.dispose();
		this.runtime.disposeFn();
	}
	public dispose(): void {
		if (this.disposed.signal.aborted) {
			return;
		}
		this.stop("summarizerClientDisconnected");
		this.disposed.abort(new UsageError("Summarizer disposed"));
		this.legacyConnection?.stop("summarizerClientDisconnected");
		this.releaseExecutor();
	}

	public summarizeOnDemand(options: IOnDemandSummarizeOptions): ISummarizeResults {
		if (this.disposed.signal.aborted) {
			throw SummarizingWarning.wrap(
				new UsageError("Summarizer is already disposed."),
				false,
				this.logger,
			);
		}
		if (
			this.runtime.summarizerClientId !== undefined &&
			this.runtime.summarizerClientId !== this.runtime.clientId
		) {
			throw SummarizingWarning.wrap(
				new UsageError("On-demand summary attempted while an elected summarizer is present"),
				false,
				this.logger,
			);
		}
		if (this.runningSummarizer !== undefined) {
			return this.runningSummarizer.summarizeOnDemand(options);
		}
		const builder = new SummarizeResultBuilder();
		this.startLegacy(undefined, false).catch(() => {});
		this.legacyClient
			?.then((executor) => executor.summarizeOnDemand(options, builder))
			.catch((error: unknown) => {
				builder.fail(
					"Failed to start summarizer",
					SummarizingWarning.wrap(error, false, this.logger),
				);
			});
		return builder.build();
	}

	public enqueueSummarize(options: IEnqueueSummarizeOptions): EnqueueSummarizeResult {
		if (this.runningSummarizer === undefined) {
			throw new UsageError("Summarizer is not running");
		}
		return this.runningSummarizer.enqueueSummarize(options);
	}
	public recordSummaryAttempt(summaryRefSeqNum?: number): void {
		this.heuristicData?.recordAttempt(summaryRefSeqNum);
	}
	public static stopReasonCanRunLastSummary(reason: SummarizerStopReason): boolean {
		return reason === "parentNotConnected";
	}
}
