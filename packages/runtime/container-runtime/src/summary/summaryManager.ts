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
import {
	createChildLogger,
	type TelemetryLoggerExt,
} from "@fluidframework/telemetry-utils/internal";
import type { IThrottler } from "../throttler.js";
import type { ISummarizerClientElection } from "./summarizerClientElection.js";
import type {
	ISummarizer,
	IOnDemandSummarizeOptions,
	IEnqueueSummarizeOptions,
} from "./summarizerTypes.js";
import type { SummaryCollection } from "./summaryCollection.js";
import {
	type SummaryExecutionSource,
	type SummaryClient,
	untilAborted,
	waitForStop,
} from "./summaryExecution.js";
import type {
	ISummarizeResults,
	EnqueueSummarizeResult,
} from "./summaryDelayLoadedModule/index.js";

export enum SummaryManagerState {
	Off,
	Starting,
	Running,
	Stopping,
}
export interface IConnectedEvents extends IEvent {
	(event: "connected", listener: (clientId: string) => void): void;
	(event: "disconnected", listener: () => void): void;
}
export interface IConnectedState extends IEventProvider<IConnectedEvents> {
	readonly connected: boolean;
	readonly clientId: string | undefined;
}
export interface ISummaryManagerConfig {
	initialDelayMs: number;
	opsToBypassInitialDelay: number;
}

/** Election-driven supervisor. One awaited resource scope owns each second client. */
export class SummaryManager
	extends TypedEventEmitter<ISummarizerEvents>
	implements IDisposable
{
	private readonly logger: TelemetryLoggerExt;
	private readonly lifetime = new AbortController();
	private task: Promise<void> | undefined;
	private stopRequest: AbortController | undefined;
	private client: SummaryClient | undefined;
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private parentId: string | undefined;
	private readonly config: ISummaryManagerConfig;
	public get disposed(): boolean {
		return this.lifetime.signal.aborted;
	}
	public get currentState(): SummaryManagerState {
		return this.task === undefined
			? SummaryManagerState.Off
			: this.stopRequest === undefined
				? SummaryManagerState.Starting
				: this.stopRequest.signal.aborted
					? SummaryManagerState.Stopping
					: SummaryManagerState.Running;
	}
	constructor(
		private readonly election: ISummarizerClientElection,
		private readonly connection: IConnectedState,
		private readonly summaries: Pick<
			SummaryCollection,
			"opsSinceLastAck" | "addOpListener" | "removeOpListener"
		>,
		logger: ITelemetryBaseLogger,
		private readonly withClient: <T>(
			signal: AbortSignal,
			action: (client: ISummarizer) => Promise<T>,
		) => Promise<T>,
		private readonly throttler: IThrottler,
		config: Readonly<Partial<ISummaryManagerConfig>> = {},
	) {
		super();
		this.logger = createChildLogger({ logger, namespace: "SummaryManager" });
		this.config = { initialDelayMs: 5000, opsToBypassInitialDelay: 4000, ...config };
		this.parentId = connection.clientId;
		connection.on("connected", this.connected);
		connection.on("disconnected", this.refresh);
	}
	public start(): void {
		this.election.on("electedSummarizerChanged", this.refresh);
		this.refresh();
	}
	private readonly connected = (id: string): void => {
		this.parentId = id;
		this.refresh();
	};
	private responsibility(): SummarizerStopReason | undefined {
		if (this.disposed) {
			return "parentNotConnected";
		}
		if (this.connection.clientId !== this.election.electedParentId) {
			return "notElectedParent";
		}
		return this.connection.connected ? undefined : "parentNotConnected";
	}
	private mayOpen(): boolean {
		return (
			this.responsibility() === undefined &&
			this.connection.clientId === this.election.electedClientId
		);
	}
	private readonly refresh = (): void => {
		const reason = this.responsibility();
		if (this.stopRequest !== undefined) {
			if (reason !== undefined && !this.stopRequest.signal.aborted) {
				this.stopRequest.abort(reason);
			}
		} else if (this.task === undefined && this.mayOpen()) {
			// The sole background root: synchronous election events cannot await supervision.
			this.task = this.supervise();
		}
	};

	private async supervise(): Promise<void> {
		const abort = new AbortController();
		try {
			const delayed = this.summaries.opsSinceLastAck < this.config.opsToBypassInitialDelay;
			await this.delay(
				Math.max(this.throttler.getDelay(), delayed ? this.config.initialDelayMs : 0),
			);
			if (this.disposed || (delayed && !this.mayOpen())) {
				return;
			}
			const stop = new AbortController();
			this.stopRequest = stop;
			const drain = (): void => {
				this.deadline = setTimeout(
					() => abort.abort(new Error("Summarizer stop deadline exceeded")),
					2 * 60 * 1000,
				);
			};
			stop.signal.addEventListener("abort", drain, { once: true });
			try {
				await this.withClient(abort.signal, async (child) => {
					const removeEvents = this.forward(child);
					try {
						const reason = this.responsibility();
						if (reason !== undefined) {
							stop.abort(reason);
							if (delayed || reason !== "parentNotConnected") {
								return;
							}
						}
						const source = child as ISummarizer & Partial<SummaryExecutionSource>;
						// eslint-disable-next-line unicorn/no-negated-condition -- Direct path precedes the legacy adapter.
						if (source.withSummarizer !== undefined) {
							await source.withSummarizer(
								{
									onBehalfOf: this.parentId,
									stop: stop.signal,
									abort: abort.signal,
									allowLastSummary: true,
								},
								async (client) => {
									this.client = client;
									await waitForStop(stop.signal);
								},
							);
						} else {
							const requestStop = (): void =>
								child.stop(stop.signal.reason as SummarizerStopReason);
							stop.signal.addEventListener("abort", requestStop, { once: true });
							try {
								if (stop.signal.aborted) {
									requestStop();
								}
								this.client = child;
								await untilAborted(child.run(this.parentId ?? ""), abort.signal);
							} finally {
								stop.signal.removeEventListener("abort", requestStop);
							}
						}
					} finally {
						this.client = undefined;
						removeEvents();
					}
				});
			} finally {
				stop.signal.removeEventListener("abort", drain);
			}
		} catch (error) {
			if (!this.disposed) {
				this.logger.sendTelemetryEvent(
					{ eventName: "EndingSummarizer", reason: "exception" },
					error,
				);
			}
		} finally {
			clearTimeout(this.deadline);
			this.stopRequest = undefined;
			this.task = undefined;
			this.refresh();
		}
	}

	private async delay(ms: number): Promise<void> {
		if (ms <= 0) {
			return;
		}
		let finish: () => void = () => {};
		const elapsed = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const timer = setTimeout(finish, ms);
		const onOp = (): void => {
			if (this.summaries.opsSinceLastAck >= this.config.opsToBypassInitialDelay) {
				finish();
			}
		};
		this.summaries.addOpListener(onOp);
		try {
			await untilAborted(elapsed, this.lifetime.signal);
		} finally {
			clearTimeout(timer);
			this.summaries.removeOpListener(onOp);
		}
	}

	public summarizeOnDemand(options: IOnDemandSummarizeOptions): ISummarizeResults {
		if (this.client === undefined) {
			throw new Error("No running summarizer client");
		}
		return this.client.summarizeOnDemand(options);
	}
	public enqueueSummarize(options: IEnqueueSummarizeOptions): EnqueueSummarizeResult {
		if (this.client === undefined) {
			throw new Error("No running summarizer client");
		}
		return this.client.enqueueSummarize(options);
	}
	public dispose(): void {
		this.election.off("electedSummarizerChanged", this.refresh);
		this.connection.off("connected", this.connected);
		this.connection.off("disconnected", this.refresh);
		this.lifetime.abort();
		this.refresh();
	}
	private forward(child: ISummarizer): () => void {
		const remove: (() => void)[] = [];
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
			remove.push(() => child.off(event as any, listener));
		}
		return () => {
			for (const off of remove) {
				off();
			}
		};
	}
}
