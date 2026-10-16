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
import { assert, Deferred } from "@fluidframework/core-utils/internal";
import {
	createChildLogger,
	type IFluidErrorBase,
	LoggingError,
	type TelemetryLoggerExt,
	UsageError,
	wrapErrorAndLog,
} from "@fluidframework/telemetry-utils/internal";

import type {
	IEnqueueSummarizeOptions,
	IOnDemandSummarizeOptions,
	ISummarizeHeuristicData,
	ISummarizer,
	ISummarizerInternalsProvider,
	ISummarizerRuntime,
	ISummarizingWarning,
	ISummaryConfiguration,
} from "../summarizerTypes.js";
import type { SummaryCollection } from "../summaryCollection.js";

import {
	RunWhileConnectedCoordinator,
	type ICancellableSummarizerController,
	type SummarizerConnection,
} from "./runWhileConnectedCoordinator.js";
import { RunningSummarizer } from "./runningSummarizer.js";
import { SummarizeHeuristicData } from "./summarizerHeuristics.js";
import { SummarizeResultBuilder } from "./summaryResultBuilder.js";
import type { EnqueueSummarizeResult, ISummarizeResults } from "./summaryResultTypes.js";

/**
 * The maximum number of summarization attempts that will be done by default in case of failures
 * that can be retried.
 */
export const defaultMaxAttempts = 2;
/**
 * The default value for maximum number of summarization attempts that will be done for summarization failures where
 * submit fails and the failure can be retried.
 */
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
		const newErrorFn = (errMsg: string): SummarizingWarning =>
			new SummarizingWarning(errMsg, logged);
		return wrapErrorAndLog<SummarizingWarning>(error, newErrorFn, logger);
	}
}

export const createSummarizingWarning = (
	errorMessage: string,
	logged: boolean,
): SummarizingWarning => new SummarizingWarning(errorMessage, logged);

/**
 * Summarizer is responsible for coordinating when to generate and send summaries.
 * It is the main entry point for summary work.
 * It is created only by summarizing container (i.e. one with clientType === "summarizer")
 * @internal
 */
export class Summarizer extends TypedEventEmitter<ISummarizerEvents> implements ISummarizer {
	public get ISummarizer(): this {
		return this;
	}

	private readonly logger: TelemetryLoggerExt;
	private runningSummarizer?: RunningSummarizer;
	private _disposed: boolean = false;
	private lifecycle: Promise<SummarizerStopReason> | undefined;
	private readonly executorReady = new Deferred<
		{ readonly executor: RunningSummarizer } | { readonly error: unknown }
	>();

	private readonly stopDeferred = new Deferred<SummarizerStopReason>();
	private readonly disposedDeferred = new Deferred<undefined>();
	private runCoordinator: ICancellableSummarizerController | undefined;

	constructor(
		/**
		 * Reference to runtime that created this object.
		 * i.e. runtime with clientType === "summarizer"
		 */

		private readonly runtime: ISummarizerRuntime,
		private readonly configurationGetter: () => ISummaryConfiguration,
		/**
		 * Represents an object that can generate summary.
		 * In practical terms, it's same runtime (this.runtime) with clientType === "summarizer".
		 */

		private readonly internalsProvider: ISummarizerInternalsProvider,
		handleContext: IFluidHandleContext,
		public readonly summaryCollection: SummaryCollection,
		private readonly active: () => boolean,
	) {
		super();
		this.logger = createChildLogger({
			logger: this.runtime.baseLogger,
			namespace: "Summarizer",
		});
	}

	public async run(onBehalfOf: string): Promise<SummarizerStopReason> {
		try {
			return await this.ensureLifecycle({
				onBehalfOf,
				allowLastSummary: true,
			});
		} catch (error) {
			throw SummarizingWarning.wrap(error, false /* logged */, this.logger);
		}
	}

	/**
	 * Stops the summarizer from running.  This will complete
	 * the run promise, and also close the container.
	 * @param reason - reason code for stopping
	 */
	public stop(reason: SummarizerStopReason): void {
		this.stopDeferred.resolve(reason);
	}

	public close(): void {
		// This will result in "summarizerClientDisconnected" stop reason recorded in telemetry,
		// unless stop() was called earlier
		this.dispose();
		this.runtime.disposeFn();
	}

	/** The first invocation owns the child's lifecycle policy; later callers share its startup. */
	private async ensureLifecycle(options: {
		onBehalfOf: string | undefined;
		allowLastSummary: boolean;
	}): Promise<SummarizerStopReason> {
		if (this.lifecycle === undefined) {
			this.lifecycle = this.runLifecycle(options);
			// Explicit requests observe startup failures through executorReady instead of this promise.
			// eslint-disable-next-line no-void
			void this.lifecycle.catch(() => {});
		}
		return this.lifecycle;
	}

	/** Owns connection, executor startup, graceful drain, and closure for either invocation mode. */
	private async runLifecycle({
		onBehalfOf,
		allowLastSummary,
	}: {
		onBehalfOf: string | undefined;
		allowLastSummary: boolean;
	}): Promise<SummarizerStopReason> {
		let runCoordinator: SummarizerConnection | undefined;
		let stopReason: SummarizerStopReason = "summarizerException";
		let failure: unknown;
		try {
			runCoordinator = RunWhileConnectedCoordinator.open(this.runtime, this.active);
			this.runCoordinator = runCoordinator;
			const readiness = await runCoordinator.ready;
			if (readiness === "timeout") {
				this.logger.sendTelemetryEvent({
					eventName: "CreateRunCoordinatorTimeout",
					onBehalfOf,
					timeoutMs: 2 * 60 * 1000,
				});
			}
			if (this._disposed || readiness === "timeout") {
				stopReason = "summarizerClientDisconnected";
				return "summarizerClientDisconnected";
			}
			const parentId = onBehalfOf ?? this.runtime.clientId;
			assert(parentId !== undefined, "A connected summarizer must have a parent client ID.");

			// Wait for either external signal to cancel, or loss of connectivity.
			const stopP = Promise.race([runCoordinator.waitCancelled, this.stopDeferred.promise]);
			// eslint-disable-next-line no-void
			void stopP.then((reason) => {
				this.logger.sendTelemetryEvent({
					eventName: "StoppingSummarizer",
					onBehalfOf,
					reason,
				});
			});

			if (runCoordinator.cancelled) {
				stopReason = await runCoordinator.waitCancelled;
				this.emit("summarizerStartupFailed", {
					reason: stopReason,
					numUnsummarizedRuntimeOps: this._heuristicData?.numRuntimeOps,
					numUnsummarizedNonRuntimeOps: this._heuristicData?.numNonRuntimeOps,
				});
				return stopReason;
			}

			this.emit("summarizerStart", {
				onBehalfOf,
				numUnsummarizedRuntimeOps: this._heuristicData?.numRuntimeOps,
				numUnsummarizedNonRuntimeOps: this._heuristicData?.numNonRuntimeOps,
			});

			const runningSummarizer = await Promise.race([
				this.start(parentId, runCoordinator),
				this.disposedDeferred.promise,
			]);
			if (runningSummarizer === undefined) {
				stopReason = "summarizerClientDisconnected";
				return stopReason;
			}
			this.executorReady.resolve({ executor: runningSummarizer });
			stopReason = await stopP;
			await this.drain(
				runningSummarizer,
				runCoordinator,
				parentId,
				allowLastSummary && Summarizer.stopReasonCanRunLastSummary(stopReason),
			);
			return stopReason;
		} catch (error) {
			failure = error;
			this.executorReady.resolve({ error });
			this.stop("summarizerException");
			throw error;
		} finally {
			this.executorReady.resolve({
				error: new UsageError("Summarizer stopped before becoming ready"),
			});
			this.emit("summarizerStop", {
				stopReason,
				error: failure,
				numUnsummarizedRuntimeOps: this._heuristicData?.numRuntimeOps,
				numUnsummarizedNonRuntimeOps: this._heuristicData?.numNonRuntimeOps,
			});
			runCoordinator?.stop(stopReason);
			this.runCoordinator = undefined;
			this.close();
		}
	}

	/** Drains execution before cancelling its connection controller, with a bounded wait. */
	private async drain(
		runningSummarizer: RunningSummarizer,
		runCoordinator: ICancellableSummarizerController,
		onBehalfOf: string,
		allowLastSummary: boolean,
	): Promise<void> {
		// Graceful stopping must not cancel an active attempt before its ack or retry delay completes.
		const waitStopPromise = runningSummarizer.waitStop(
			!runCoordinator.cancelled && allowLastSummary,
		);
		const summarizerStopTimeoutMs = 2 * 60 * 1000; // 2 minutes
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), summarizerStopTimeoutMs);
		});
		try {
			const waitStopResult = await Promise.race([waitStopPromise, timeoutPromise]);
			if (waitStopResult === "timeout") {
				this.logger.sendTelemetryEvent({
					eventName: "SummarizerStopTimeout",
					onBehalfOf,
					timeoutMs: summarizerStopTimeoutMs,
				});
			}
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}

	/**
	 * Should we try to run a last summary for the given stop reason?
	 * Currently only allows "parentNotConnected"
	 * @param stopReason - SummarizerStopReason
	 * @returns `true` if the stop reason can run a last summary, otherwise `false`.
	 */
	public static stopReasonCanRunLastSummary(stopReason: SummarizerStopReason): boolean {
		return stopReason === "parentNotConnected";
	}

	private _heuristicData: ISummarizeHeuristicData | undefined;

	/**
	 * Put the summarizer in a started state, including creating and initializing the RunningSummarizer.
	 * The start request can come either from the SummaryManager (in the auto-summarize case) or from the user
	 * (in the on-demand case).
	 * @param onBehalfOf - ID of the client that requested that the summarizer start
	 * @param runCoordinator - cancellation token
	 * @returns A promise that is fulfilled when the RunningSummarizer is ready.
	 */
	private async start(
		onBehalfOf: string,

		runCoordinator: ICancellableSummarizerController,
	): Promise<RunningSummarizer> {
		if (this._disposed) {
			throw new UsageError("Starting a disposed summarizer");
		}
		if (this.runningSummarizer) {
			if (this.runningSummarizer.disposed) {
				throw new UsageError("Starting a disposed summarizer");
			}
			return this.runningSummarizer;
		}
		// Initialize values and first ack (time is not exact)
		this.logger.sendTelemetryEvent({
			eventName: "RunningSummarizer",
			onBehalfOf,
			initSummarySeqNumber: this.runtime.deltaManager.initialSequenceNumber,
			config: JSON.stringify(this.configurationGetter()),
		});

		// Summarizing container ID (with clientType === "summarizer")
		const clientId = this.runtime.clientId;
		if (clientId === undefined) {
			throw new UsageError("clientId should be defined if connected.");
		}

		this._heuristicData = new SummarizeHeuristicData(
			this.runtime.deltaManager.lastSequenceNumber,
			{
				/**
				 * summary attempt baseline for heuristics
				 */
				refSequenceNumber: this.runtime.deltaManager.initialSequenceNumber,
				summaryTime: Date.now(),
			} as const,
		);

		const runningSummarizer = await RunningSummarizer.start(
			this.logger,
			this.summaryCollection.createWatcher(clientId),
			this.configurationGetter(),
			async (...args) => this.internalsProvider.submitSummary(...args), // submitSummaryCallback
			async (...args) => this.internalsProvider.refreshLatestSummaryAck(...args), // refreshLatestSummaryAckCallback
			this._heuristicData,
			this.summaryCollection,
			runCoordinator /* cancellationToken */,
			(reason) => runCoordinator.stop(reason) /* stopSummarizerCallback */,
			this.runtime,
		);
		if (this._disposed) {
			runningSummarizer.dispose();
			throw new UsageError("Summarizer was disposed during startup");
		}
		this.runningSummarizer = runningSummarizer;
		this.setupForwardedEvents(runningSummarizer);
		return runningSummarizer;
	}

	/**
	 * Disposes of resources after running.  This cleanup will
	 * clear any outstanding timers and reset some of the state
	 * properties.
	 * Called by ContainerRuntime when it is disposed, as well as at the end the run().
	 */
	public dispose(): void {
		if (this._disposed) {
			return;
		}
		// Given that the call can come from own ContainerRuntime, ensure that we stop all the processes.
		this.stop("summarizerClientDisconnected");

		this._disposed = true;
		this.runCoordinator?.stop("summarizerClientDisconnected");
		this.disposedDeferred.resolve(undefined);
		this.executorReady.resolve({
			error: new UsageError("Summarizer was disposed before becoming ready"),
		});
		if (this.runningSummarizer) {
			this.cleanupForwardedEvents();
			this.runningSummarizer.dispose();
			this.runningSummarizer = undefined;
		}
	}

	public summarizeOnDemand(options: IOnDemandSummarizeOptions): ISummarizeResults {
		try {
			if (this._disposed || this.runningSummarizer?.disposed === true) {
				throw new UsageError("Summarizer is already disposed.");
			}
			if (
				this.runtime.summarizerClientId !== undefined &&
				this.runtime.summarizerClientId !== this.runtime.clientId
			) {
				// If there is an elected summarizer, and it's not this one, don't allow on-demand summary.
				// This is to prevent the on-demand summary and heuristic-based summary from stepping on
				// each other.
				throw new UsageError(
					"On-demand summary attempted while an elected summarizer is present",
				);
			}
			const builder = new SummarizeResultBuilder();
			if (this.runningSummarizer) {
				// Summarizer is already running. Go ahead and start.
				return this.runningSummarizer.summarizeOnDemand(options, builder);
			}

			const lifecycle = this.ensureLifecycle({
				onBehalfOf: undefined,
				allowLastSummary: false,
			});
			// Each request waits for the same executor; its existing lock decides concurrency policy.
			// eslint-disable-next-line no-void
			void this.executorReady.promise
				.then(async (ready) => {
					if ("error" in ready) {
						throw ready.error;
					}
					if (this._disposed || ready.executor.disposed) {
						throw new UsageError("Summarizer closed before the request could run");
					}
					ready.executor.summarizeOnDemand(options, builder);
					return lifecycle;
				})
				.then(() => {
					if (!builder.receivedSummaryAckOrNack.isCompleted) {
						builder.fail(
							"On-demand summarizer stopped before the request completed",
							new UsageError("Summarizer stopped before the request completed"),
						);
					}
				})
				.catch((error: unknown) => {
					if (!builder.receivedSummaryAckOrNack.isCompleted) {
						builder.fail(
							"Failed to run on-demand summarizer",
							SummarizingWarning.wrap(error, false, this.logger),
						);
					}
				});

			return builder.build();
		} catch (error) {
			throw SummarizingWarning.wrap(error, false /* logged */, this.logger);
		}
	}

	public enqueueSummarize(options: IEnqueueSummarizeOptions): EnqueueSummarizeResult {
		if (
			this._disposed ||
			this.runningSummarizer === undefined ||
			this.runningSummarizer.disposed
		) {
			throw new UsageError("Summarizer is not running or already disposed.");
		}
		return this.runningSummarizer.enqueueSummarize(options);
	}

	public recordSummaryAttempt?(summaryRefSeqNum?: number): void {
		this._heuristicData?.recordAttempt(summaryRefSeqNum);
	}

	private readonly forwardedEventsCleanup: (() => void)[] = [];

	private setupForwardedEvents(runningSummarizer: RunningSummarizer): void {
		for (const event of [
			"summarize",
			"summarizeAllAttemptsFailed",
			"summarizeTimeout",
		] as const) {
			const listener = (...args: unknown[]): void => {
				this.emit(event, ...args);
			};
			runningSummarizer.on(event, listener);
			this.forwardedEventsCleanup.push(() => runningSummarizer.off(event, listener));
		}
	}

	private cleanupForwardedEvents(): void {
		for (const cleanup of this.forwardedEventsCleanup) {
			cleanup();
		}
		this.forwardedEventsCleanup.length = 0;
	}
}
