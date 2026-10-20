/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { createEmitter, TypedEventEmitter } from "@fluid-internal/client-utils";
import type { ISummarizerEvents } from "@fluidframework/container-runtime-definitions/internal";
import type {
	IDisposable,
	IEvent,
	IEventProvider,
	ITelemetryBaseLogger,
} from "@fluidframework/core-interfaces";
import { assert } from "@fluidframework/core-utils/internal";
import { DriverErrorTypes } from "@fluidframework/driver-definitions/internal";
import {
	createChildLogger,
	PerformanceEvent,
	type TelemetryLoggerExt,
} from "@fluidframework/telemetry-utils/internal";

import type { IThrottler } from "../throttler.js";

import type { ISummarizerClientElection } from "./summarizerClientElection.js";
import type {
	IEnqueueSummarizeOptions,
	IOnDemandSummarizeOptions,
	ISummarizer,
} from "./summarizerTypes.js";
import type { SummaryCollection } from "./summaryCollection.js";
import type {
	EnqueueSummarizeResult,
	ISummarizeResults,
} from "./summaryDelayLoadedModule/index.js";

const defaultInitialDelayMs = 5000;
const defaultOpsToBypassInitialDelay = 4000;

export enum SummaryManagerState {
	/** No active lifecycle or owned child. */
	Idle,
	/** Waiting before issuing a creation request. */
	Waiting,
	/** Creation requested; the child reference is not yet available. */
	Loading,
	/** The returned child's run() lifetime has begun. */
	Running,
	/** Committed to ending the cycle, including pending load, drain, and cleanup. */
	Stopping,
}

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
	 * Local connection identity. The manager captures it when eligible to start a lifecycle,
	 * retaining that parent identity even if the connection subsequently changes.
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
	/** Parent identity captured at lifecycle eligibility and retained through disconnect/reconnect. */
	private parentClientId: string | undefined;
	private state = SummaryManagerState.Idle;
	private summarizer?: ISummarizer;
	private _disposed = false;
	private started = false;
	private readonly internalEvents = createEmitter<{
		disposed: () => void;
	}>();

	public get disposed(): boolean {
		return this._disposed;
	}

	public get currentState(): SummaryManagerState {
		return this.state;
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
		 * Creates summarizer by asking interactive container to spawn summarizing container and
		 * get back its Summarizer instance.
		 */
		private readonly createSummarizerFn: () => Promise<ISummarizer>,
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
				all: { clientId: () => this.parentClientId },
			},
		});

		this.opsToBypassInitialDelay = opsToBypassInitialDelay;
		this.initialDelayMs = initialDelayMs;
	}

	/**
	 * Until start is called, the SummaryManager won't begin attempting to start summarization.  This ensures there's
	 * a window between construction and starting where the caller can attach listeners.
	 */
	public start(): void {
		if (this.started || this.disposed) {
			return;
		}
		this.started = true;
		this.supervise().catch((error) => {
			this.logger.sendErrorEvent({ eventName: "SummarizerSupervisorException" }, error);
		});
	}

	private async supervise(): Promise<void> {
		type StartupDecision =
			| { outcome: "disposed" }
			| {
					outcome: "eligible";
					parentClientId: string;
					allowLastSummaryAfterParentDisconnect: boolean;
			  };

		/**
		 * Waits for startup delay or the op threshold, whichever occurs first.
		 * @param urgent - Whether the initial op count permits bypassing the boot delay.
		 */
		const delayBeforeCreatingSummarizer = async (urgent: boolean): Promise<void> => {
			// throttle creation of new summarizer containers to prevent spamming the server with websocket connections
			let delayMs = this.startThrottler.recordAttemptAndGetDelay();

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
				hasSummarizer: this.clientElection.hasSummarizer,
			});

			if (!urgent) {
				delayMs = Math.max(delayMs, this.initialDelayMs);
			}

			if (delayMs > 0) {
				await new Promise<void>((resolve) => {
					const complete = (): void => {
						clearTimeout(timer);
						this.summaryCollection.removeOpListener(opsListener);
						resolve();
					};
					const timer = setTimeout(complete, delayMs);
					// An incoming op crossing the threshold bypasses both initial delay and throttling.
					const opsListener = (): void => {
						if (this.summaryCollection.opsSinceLastAck >= this.opsToBypassInitialDelay) {
							complete();
						}
					};
					this.summaryCollection.addOpListener(opsListener);
				});
			}
		};

		const waitForEligibility = async (): Promise<StartupDecision> =>
			new Promise<StartupDecision>((resolve) => {
				const removeListeners = (): void => {
					this.connectedState.off("connected", checkEligibility);
					this.clientElection.events.off("electedSummarizerChanged", checkEligibility);
					this.internalEvents.off("disposed", onDisposed);
				};
				const onDisposed = (): void => {
					removeListeners();
					resolve({ outcome: "disposed" });
				};
				const checkEligibility = (): void => {
					const parentClientId = this.connectedState.clientId;
					if (
						parentClientId === undefined ||
						this.disposed ||
						!this.connectedState.connected ||
						parentClientId !== this.clientElection.electedParentId ||
						this.clientElection.hasSummarizer
					) {
						return;
					}
					removeListeners();
					this.parentClientId = parentClientId;
					this.state = SummaryManagerState.Waiting;
					resolve({
						outcome: "eligible",
						parentClientId,
						allowLastSummaryAfterParentDisconnect:
							this.summaryCollection.opsSinceLastAck >= this.opsToBypassInitialDelay,
					});
				};
				this.connectedState.on("connected", checkEligibility);
				this.clientElection.events.on("electedSummarizerChanged", checkEligibility);
				this.internalEvents.on("disposed", onDisposed);
				checkEligibility();
			});

		const prepareCreation = async (
			startup: Extract<StartupDecision, { outcome: "eligible" }>,
		): Promise<boolean> => {
			await delayBeforeCreatingSummarizer(startup.allowLastSummaryAfterParentDisconnect);
			if (this.disposed) {
				this.logger.sendTelemetryEvent({
					eventName: "EndingSummarizer",
					reason: "early exit (disposed)",
				});
				return false;
			}

			// A disconnected parent may still request a last summary when many ops remain.
			const canCreate =
				this.connectedState.clientId === this.clientElection.electedParentId &&
				!this.clientElection.hasSummarizer &&
				(this.connectedState.connected || startup.allowLastSummaryAfterParentDisconnect);
			if (!canCreate) {
				this.logger.sendTelemetryEvent({
					eventName: "EndingSummarizer",
					reason: "early exit before summarizer creation",
				});
			}
			return canCreate;
		};

		const runSummarization = async (
			parentClientId: string,
			allowLastSummaryAfterParentDisconnect: boolean,
		): Promise<void> => {
			// Creation has been authorized; adopt ownership before the child can join quorum.
			assert(this.state === SummaryManagerState.Waiting, 0x263 /* "Expected: waiting" */);
			this.state = SummaryManagerState.Loading;
			let summarizer: ISummarizer | undefined;
			let reason = "exception";
			let parentDisconnected = !this.connectedState.connected;
			let removeListeners = (): void => {};
			try {
				const stopTimeout = new Promise<string>((resolve) => {
					let timer: ReturnType<typeof setTimeout> | undefined;
					const clearTimer = (): void => clearTimeout(timer);
					let stopRequested = false;
					const onDisconnected = (): void => {
						if (stopRequested) {
							return;
						}
						stopRequested = true;
						parentDisconnected = true;
						this.state = SummaryManagerState.Stopping;
						timer = setTimeout(
							() => {
								if (summarizer !== undefined) {
									this.logger.sendTelemetryEvent({
										eventName: "SummarizerStopTimeout",
										timeoutMs: 2 * 60 * 1000,
										stopReason: "parentNotConnected",
									});
									resolve("summarizerStopTimeout");
								}
							},
							2 * 60 * 1000,
						);
						summarizer?.stop("parentNotConnected");
					};
					removeListeners = () => {
						clearTimer();
						this.connectedState.off("disconnected", onDisconnected);
						this.internalEvents.off("disposed", onDisposed);
					};
					const onDisposed = (): void => {
						removeListeners();
					};
					this.connectedState.on("disconnected", onDisconnected);
					this.internalEvents.on("disposed", onDisposed);
					if (parentDisconnected) {
						onDisconnected();
					}
				});

				summarizer = await this.createSummarizerFn();
				this.summarizer = summarizer;
				this.setupForwardedEvents(summarizer);

				// A stop may have been requested while we were awaiting summarizer creation.
				// Replay it now so the summarizer can observe the stop intent and move to exit.
				if (parentDisconnected) {
					summarizer.stop("parentNotConnected");
				}

				// This cycle's disconnect remains authoritative even after reconnect or parent succession.
				// Only urgent startups may run a late child for a last-summary attempt.
				if (this.disposed || parentDisconnected) {
					if (allowLastSummaryAfterParentDisconnect) {
						this.logger.sendTelemetryEvent({
							eventName: "LastAttemptToSummarize",
						});
					} else {
						this.state = SummaryManagerState.Stopping;
						summarizer.stop("parentNotConnected");
						reason = "early exit after starting summarizer parentNotConnected";
						return;
					}
				}

				const child = summarizer;
				// Stop intent is sticky even if the parent reconnects while creation is pending.
				if (this.state === SummaryManagerState.Loading) {
					this.state = SummaryManagerState.Running;
				}
				// This performance interval ends when manager ownership ends, including forced timeout.
				reason = await PerformanceEvent.timedExecAsync(
					this.logger,
					{ eventName: "RunningSummarizer", attempt: this.startThrottler.numAttempts },
					async () => Promise.race([child.run(parentClientId), stopTimeout]),
				);
			} catch (error) {
				reason = "exception";
				this.logger.sendTelemetryEvent(
					{
						eventName: "EndingSummarizer",
						reason: "exception",
					},
					error,
				);

				// Most of exceptions happen due to container being closed while loading it, due to
				// summarizer container loosing connection while load.
				// Not worth reporting such errors as errors. That said, we might miss some real errors if
				// we ignore blindly, so try to narrow signature we are looking for - skip logging
				// error only if this client should no longer be a summarizer (which in practice
				// means it also lost connection), and error happened on load (we do not have summarizer).
				// We could annotate the error raised in Container.load where the container closed during load with no error
				// and check for that case here, but that does not seem to be necessary.
				if ((!this.disposed && !parentDisconnected) || summarizer !== undefined) {
					// Report any failure as an error unless it was due to cancellation (like "disconnected" error)
					// If failure happened on container load, we may not yet realized that socket disconnected, so check
					// offlineError.
					const category =
						typeof error === "object" &&
						error !== null &&
						"errorType" in error &&
						error.errorType === DriverErrorTypes.offlineError
							? "generic"
							: "error";
					this.logger.sendTelemetryEvent(
						{
							eventName: "SummarizerException",
							category,
						},
						error,
					);
				}
			} finally {
				if (reason !== "exception") {
					this.logger.sendTelemetryEvent({ eventName: "EndingSummarizer", reason });
				}
				// Stay non-idle while close() can synchronously trigger connection or quorum callbacks.
				this.state = SummaryManagerState.Stopping;
				removeListeners();
				this.cleanupForwardedEvents();
				this.summarizer = undefined;
				summarizer?.close();
			}
		};

		while (!this.disposed) {
			const startup = await waitForEligibility();
			if (startup.outcome === "disposed") {
				return;
			}
			if (await prepareCreation(startup)) {
				try {
					await runSummarization(
						startup.parentClientId,
						startup.allowLastSummaryAfterParentDisconnect,
					);
				} catch (error) {
					this.logger.sendErrorEvent({ eventName: "SummarizerCleanupException" }, error);
				}
			}
			this.state = SummaryManagerState.Idle;
		}
	}

	public summarizeOnDemand(options: IOnDemandSummarizeOptions): ISummarizeResults {
		if (this.summarizer === undefined) {
			throw new Error("No running summarizer client");
			// TODO: could spawn a summarizer client temporarily.
		}
		return this.summarizer.summarizeOnDemand(options);
	}

	public enqueueSummarize(options: IEnqueueSummarizeOptions): EnqueueSummarizeResult {
		if (this.summarizer === undefined) {
			throw new Error("No running summarizer client");
			// TODO: could spawn a summarizer client temporarily.
		}
		return this.summarizer.enqueueSummarize(options);
	}

	public dispose(): void {
		this.cleanupForwardedEvents();
		this.internalEvents.emit("disposed");
		this._disposed = true;
	}

	private readonly forwardedEventsCleanup: (() => void)[] = [];

	private setupForwardedEvents(summarizer: ISummarizer): void {
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
