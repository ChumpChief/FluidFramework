/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type {
	ISummarizerEvents,
	SummarizerStopReason,
} from "@fluidframework/container-runtime-definitions/internal";
import type {
	IDisposable,
	IEvent,
	IEventProvider,
	ITelemetryBaseLogger,
} from "@fluidframework/core-interfaces";
import { assert, Deferred } from "@fluidframework/core-utils/internal";
import { DriverErrorTypes } from "@fluidframework/driver-definitions/internal";
import {
	createChildLogger,
	PerformanceEvent,
	type TelemetryLoggerExt,
} from "@fluidframework/telemetry-utils/internal";

import type { IThrottler } from "../throttler.js";

import type { SummarizationSession } from "./summarizationSession.js";
import type { ISummarizerClientElection } from "./summarizerClientElection.js";
import type {
	IEnqueueSummarizeOptions,
	IOnDemandSummarizeOptions,
} from "./summarizerTypes.js";
import { stopReasonCanRunLastSummary } from "./summarizerUtils.js";
import type { SummaryCollection } from "./summaryCollection.js";
import type {
	EnqueueSummarizeResult,
	ISummarizeResults,
} from "./summaryDelayLoadedModule/index.js";

const defaultInitialDelayMs = 5000;
const defaultOpsToBypassInitialDelay = 4000;

export enum SummaryManagerState {
	Off = 0,
	Starting = 1,
	Running = 2,
	Stopping = 3,
}

// Please note that all reasons in this list are not errors,
// and thus they are not raised today to parent container as error.
// If this needs to be changed in future, we should re-evaluate what and how we raise to summarizer
type StopReason = Extract<
	SummarizerStopReason,
	"parentNotConnected" | "notElectedParent" | "notElectedClient"
>;
type ShouldSummarizeState =
	| { shouldSummarize: true }
	| { shouldSummarize: false; stopReason: StopReason };

export interface IConnectedEvents extends IEvent {
	(event: "connected", listener: (clientId: string) => void);
	(event: "disconnected", listener: () => void);
}

/**
 * IConnectedState describes an object that SummaryManager can watch to observe connection/disconnection.
 *
 * Under current implementation, its role will be fulfilled by the ContainerRuntime, but this could be replaced
 * with anything else that fulfills the contract if we want to shift the layer that the SummaryManager lives at.
 */
export interface IConnectedState extends IEventProvider<IConnectedEvents> {
	readonly connected: boolean;

	/**
	 * Under current implementation this is undefined if we've never connected, otherwise it's the clientId from our
	 * latest connection (even if we've since disconnected!).  Although this happens to be the behavior we want in
	 * SummaryManager, I suspect that globally we may eventually want to modify this behavior (e.g. make clientId
	 * undefined while disconnected).  To protect against this, let's assume this field can't be trusted while
	 * disconnected and instead separately track "latest clientId" in SummaryManager.
	 */
	readonly clientId: string | undefined;
}

export interface ISummaryManagerConfig {
	initialDelayMs: number;
	opsToBypassInitialDelay: number;
}

/**
 * SummaryManager is created by parent container (i.e. interactive container with clientType !== "summarizer") only.
 * It observes changes in calculated summarizer and reacts to changes by either creating summarizer client or
 * stopping existing summarizer client.
 */
export class SummaryManager
	extends TypedEventEmitter<ISummarizerEvents>
	implements IDisposable
{
	private readonly logger: TelemetryLoggerExt;
	private readonly opsToBypassInitialDelay: number;
	private readonly initialDelayMs: number;
	private latestClientId: string | undefined;
	private task: Promise<void> | undefined;
	private session?: SummarizationSession;
	private _disposed = false;
	private readonly disposedDeferred = new Deferred<void>();

	public get disposed(): boolean {
		return this._disposed;
	}

	public get currentState(): SummaryManagerState {
		if (this.task === undefined) {
			return SummaryManagerState.Off;
		}
		if (this.session === undefined) {
			return SummaryManagerState.Starting;
		}
		return this.session.isStopping
			? SummaryManagerState.Stopping
			: SummaryManagerState.Running;
	}

	constructor(
		private readonly clientElection: ISummarizerClientElection,
		private readonly connectedState: IConnectedState,
		private readonly summaryCollection: Pick<
			SummaryCollection,
			"opsSinceLastAck" | "addOpListener" | "removeOpListener"
		>,
		parentLogger: ITelemetryBaseLogger,
		/**
		 * Opens an owned session immediately, while its second client loads asynchronously.
		 */
		private readonly openSession: () => SummarizationSession,
		private readonly startThrottler: IThrottler,
		{
			initialDelayMs = defaultInitialDelayMs,
			opsToBypassInitialDelay = defaultOpsToBypassInitialDelay,
		}: Readonly<Partial<ISummaryManagerConfig>> = {},
	) {
		super();

		this.logger = createChildLogger({
			logger: parentLogger,
			namespace: "SummaryManager",
			properties: {
				all: { clientId: () => this.latestClientId },
			},
		});

		this.connectedState.on("connected", this.handleConnected);
		this.connectedState.on("disconnected", this.handleDisconnected);
		this.latestClientId = this.connectedState.clientId;

		this.opsToBypassInitialDelay = opsToBypassInitialDelay;
		this.initialDelayMs = initialDelayMs;
	}

	/**
	 * Until start is called, the SummaryManager won't begin attempting to start summarization.  This ensures there's
	 * a window between construction and starting where the caller can attach listeners.
	 */
	public start(): void {
		this.clientElection.on("electedSummarizerChanged", this.refreshSummarizer);
		this.refreshSummarizer();
	}

	private readonly handleConnected = (clientId: string): void => {
		this.latestClientId = clientId;
		// If we have a summarizer, it should have been either cancelled on disconnected by now.
		// But because of lastSummary process, it can still hang around, so there is not much we can
		// check or assert.
		this.refreshSummarizer();
	};

	private readonly handleDisconnected = (): void => {
		this.refreshSummarizer();
	};

	/** Existing sessions retain responsibility when their child becomes the elected client. */
	private getResponsibility(): ShouldSummarizeState {
		if (this.disposed) {
			return { shouldSummarize: false, stopReason: "parentNotConnected" };
		}

		// New Parent has been elected and it is not the current client, or
		if (this.connectedState.clientId !== this.clientElection.electedParentId) {
			return { shouldSummarize: false, stopReason: "notElectedParent" };
		}

		if (!this.connectedState.connected) {
			return { shouldSummarize: false, stopReason: "parentNotConnected" };
		}

		return { shouldSummarize: true };
	}

	/** Opening requires both parent responsibility and permission to replace the previous child. */
	private getOpeningEligibility(): ShouldSummarizeState {
		const responsibility = this.getResponsibility();
		if (!responsibility.shouldSummarize) {
			return responsibility;
		}
		return this.connectedState.clientId === this.clientElection.electedClientId
			? responsibility
			: { shouldSummarize: false, stopReason: "notElectedClient" };
	}

	private readonly refreshSummarizer = (): void => {
		if (this.session !== undefined) {
			const responsibility = this.getResponsibility();
			if (!responsibility.shouldSummarize) {
				this.session.stop(responsibility.stopReason);
			}
		} else if (this.task === undefined && this.getOpeningEligibility().shouldSummarize) {
			this.startSummarization();
		}
	};

	private startSummarization(): void {
		assert(this.task === undefined, "Only one supervisor task may own a session.");
		assert(this.session === undefined, "The previous summarization session must be closed.");

		this.task = this.superviseSession()
			.then((reason) => {
				this.logger.sendTelemetryEvent({
					eventName: "EndingSummarizer",
					reason,
				});
			})
			.catch((error) => {
				this.logger.sendTelemetryEvent(
					{
						eventName: "EndingSummarizer",
						reason: "exception",
					},
					error,
				);

				// Lost responsibility during load is expected; report other execution failures.
				if (this.getResponsibility().shouldSummarize || this.session?.isLoaded === true) {
					// Report any failure as an error unless it was due to cancellation (like "disconnected" error)
					// If failure happened on container load, we may not yet realized that socket disconnected, so check
					// offlineError.
					const category =
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						error?.errorType === DriverErrorTypes.offlineError ? "generic" : "error";
					this.logger.sendTelemetryEvent(
						{
							eventName: "SummarizerException",
							category,
						},
						error,
					);
				}
			})
			.finally(() => {
				this.cleanupAfterSummarizerStop();
			});
	}

	/** One task owns delay, opening, execution, and draining before eligibility is reconsidered. */
	private async superviseSession(): Promise<string | undefined> {
		const delayed = await this.delayBeforeCreatingSummarizer();
		if (this.disposed) {
			return "early exit (disposed)";
		}
		const eligibility = this.getOpeningEligibility();
		// Urgent startup is allowed to finish a last summary even if its parent has disconnected.
		// Preserve that recovery policy when the service is rejecting unsummarized ops.
		if (delayed && !eligibility.shouldSummarize) {
			return `early exit ${eligibility.stopReason}`;
		}

		const session = this.openSession();
		this.session = session;
		this.setupForwardedEvents(session);
		// Completion is local; quorum election still controls permission to open a replacement.
		// eslint-disable-next-line no-void
		void session.closed.then((outcome) => {
			if (outcome.kind === "timeout") {
				this.logger.sendTelemetryEvent({
					eventName: "SummarizerStopTimeout",
					timeoutMs: 2 * 60 * 1000,
					stopReason: outcome.reason,
				});
			}
		});
		if (!(await session.loaded)) {
			return "session closed during creation";
		}

		const responsibility = this.getResponsibility();
		if (!responsibility.shouldSummarize) {
			session.stop(responsibility.stopReason);
			if (delayed || !stopReasonCanRunLastSummary(responsibility.stopReason)) {
				return `early exit after starting summarizer ${responsibility.stopReason}`;
			}
			this.logger.sendTelemetryEvent({ eventName: "LastAttemptToSummarize" });
		}
		const clientId = this.latestClientId;
		assert(clientId !== undefined, "An elected supervisor must have a parent client ID.");
		return PerformanceEvent.timedExecAsync(
			this.logger,
			{ eventName: "RunningSummarizer", attempt: this.startThrottler.numAttempts },
			async () => session.run(clientId),
		);
	}

	private cleanupAfterSummarizerStop(): void {
		this.cleanupForwardedEvents();
		this.session?.close();
		this.session = undefined;
		this.task = undefined;
		this.refreshSummarizer();
	}

	/**
	 * Implements initial delay before creating summarizer
	 * @returns `true`, if creation is delayed due to heuristics (not many ops to summarize).
	 * `false` if summarizer should start immediately due to too many unsummarized ops.
	 */
	private async delayBeforeCreatingSummarizer(): Promise<boolean> {
		// throttle creation of new summarizer containers to prevent spamming the server with websocket connections
		let delayMs = this.startThrottler.getDelay();

		// We have been elected the summarizer. Some day we may be able to summarize with a live document but for
		// now we play it safe and launch a second copy.
		this.logger.sendTelemetryEvent({
			eventName: "CreatingSummarizer",
			throttlerDelay: delayMs,
			initialDelay: this.initialDelayMs,
			startThrottlerMaxDelayMs: this.startThrottler.maxDelayMs,
			opsSinceLastAck: this.summaryCollection.opsSinceLastAck,
			opsToBypassInitialDelay: this.opsToBypassInitialDelay,
			electedParentId: this.clientElection.electedParentId,
			electedClientId: this.clientElection.electedClientId,
		});

		// This delay helps ensure that last summarizer that might be left from previous client
		// has enough time to complete its last summary and thus new summarizer not conflict with previous one.
		// If, however, there are too many unsummarized ops, try to resolve it as quickly as possible, with
		// understanding that we may see nacks because of such quick action.
		// A better design would be for summarizer election logic to always select current summarizer as
		// summarizing client (i.e. clientType === "summarizer" can be elected) to ensure that nobody else can
		// summarizer while it finishes its work and moves to exit.
		// It also helps with pure boot scenario (single client) to offset expensive work a bit out from
		// critical boot sequence.
		let startWithInitialDelay = false;
		if (this.summaryCollection.opsSinceLastAck < this.opsToBypassInitialDelay) {
			startWithInitialDelay = true;
			delayMs = Math.max(delayMs, this.initialDelayMs);
		}

		if (delayMs > 0) {
			const delay = new Deferred<void>();
			const opsListenerFn = (): void => {
				if (this.summaryCollection.opsSinceLastAck >= this.opsToBypassInitialDelay) {
					delay.resolve();
				}
			};
			const timer = setTimeout(() => delay.resolve(), delayMs);
			this.summaryCollection.addOpListener(opsListenerFn);
			try {
				await Promise.race([delay.promise, this.disposedDeferred.promise]);
			} finally {
				clearTimeout(timer);
				this.summaryCollection.removeOpListener(opsListenerFn);
			}
		}
		return startWithInitialDelay;
	}

	public summarizeOnDemand(options: IOnDemandSummarizeOptions): ISummarizeResults {
		if (this.session?.isLoaded !== true) {
			throw new Error("No running summarizer client");
			// TODO: could spawn a summarizer client temporarily.
		}
		return this.session.summarizeOnDemand(options);
	}

	public enqueueSummarize(options: IEnqueueSummarizeOptions): EnqueueSummarizeResult {
		if (this.session?.isLoaded !== true) {
			throw new Error("No running summarizer client");
			// TODO: could spawn a summarizer client temporarily.
		}
		return this.session.enqueueSummarize(options);
	}

	public dispose(): void {
		this.clientElection.off("electedSummarizerChanged", this.refreshSummarizer);
		this.connectedState.off("connected", this.handleConnected);
		this.connectedState.off("disconnected", this.handleDisconnected);
		this.cleanupForwardedEvents();
		this._disposed = true;
		this.disposedDeferred.resolve();
		this.session?.stop("parentNotConnected");
	}

	private readonly forwardedEventsCleanup: (() => void)[] = [];

	private setupForwardedEvents(summarizer: SummarizationSession): void {
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
			// TODO: better typing here
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
			summarizer.on(event as any, listener);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
			this.forwardedEventsCleanup.push(() => summarizer.off(event as any, listener));
		}
	}

	private cleanupForwardedEvents(): void {
		for (const cleanup of this.forwardedEventsCleanup) {
			cleanup();
		}
		this.forwardedEventsCleanup.length = 0;
	}
}
