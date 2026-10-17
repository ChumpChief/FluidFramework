/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { SummarizerStopReason } from "@fluidframework/container-runtime-definitions/internal";
import { assert } from "@fluidframework/core-utils/internal";
import { waitForStop } from "../summaryExecution.js";

import type { IConnectableRuntime, ISummaryCancellationToken } from "../summarizerTypes.js";

/**
 * Similar to AbortController, but using promise instead of events
 * @internal
 */

export interface ICancellableSummarizerController extends ISummaryCancellationToken {
	stop(reason: SummarizerStopReason): void;
}

/**
 * Immediately owned connection lifetime, with readiness separate from construction.
 * @internal
 */
export interface SummarizerConnection extends ICancellableSummarizerController {
	readonly ready: Promise<"connected" | "stopped" | "timeout">;
}

/**
 * Can be useful in testing as well as in places where caller does not use cancellation.
 * This object implements ISummaryCancellationToken interface but cancellation is never leveraged.
 * @internal
 */

export const neverCancelledSummaryToken: ISummaryCancellationToken = {
	cancelled: false,
	waitCancelled: new Promise(() => {}),
};

/**
 * Helper class to coordinate something that needs to run only while connected.
 * This provides promises that resolve as it starts or stops.  Stopping happens
 * when disconnected or if stop() is called.
 */
export class RunWhileConnectedCoordinator implements SummarizerConnection {
	/** Child connectivity cancellation for scoped callers; graceful parent stop is separate. */
	public get signal(): AbortSignal {
		return this.transport.signal;
	}
	private readonly transport = new AbortController();
	private readonly cancellation = new AbortController();
	private readonly connection = new AbortController();
	public readonly ready: Promise<"connected" | "stopped" | "timeout">;
	private connectionTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disconnected = (): void => {
		this.transport.abort(new Error("Summary client disconnected"));
		this.stop("summarizerClientDisconnected");
	};
	private readonly onConnected = (): void => {
		this.clearConnectionTimer();
		this.connection.abort("connected");
	};

	public get cancelled(): boolean {
		if (!this.cancellation.signal.aborted) {
			assert(this.active(), 0x25d /* "We should never connect as 'read'" */);
		}

		return this.cancellation.signal.aborted;
	}

	/**
	 * Returns a promise that resolves once stopped either externally or by disconnect.
	 */
	public get waitCancelled(): Promise<SummarizerStopReason> {
		return waitForStop(this.cancellation.signal);
	}

	public static async create(
		runtime: IConnectableRuntime,
		active: () => boolean,
	): Promise<RunWhileConnectedCoordinator> {
		const obj = new RunWhileConnectedCoordinator(runtime, active);
		await obj.ready;
		return obj;
	}

	/** Returns ownership before waiting for the child connection. */
	public static open(
		runtime: IConnectableRuntime,
		active: () => boolean,
	): RunWhileConnectedCoordinator {
		return new RunWhileConnectedCoordinator(runtime, active);
	}

	protected constructor(
		private readonly runtime: IConnectableRuntime,
		private readonly active: () => boolean,
	) {
		// This promise adapts external connection events, rather than announcing internal work.
		this.ready = this.waitForConnection();
		// Only the child connection cancels execution. The supervisor separately decides
		// whether parent disconnection permits graceful draining or a last summary.
		if (this.runtime.disposed) {
			this.stop("summarizerClientDisconnected");
			return;
		}

		this.runtime.once("dispose", this.disconnected);
		// Observe disconnection before waiting so a connect/disconnect pair in one turn cannot be missed.
		this.runtime.once("disconnected", this.disconnected);

		if (this.runtime.connected) {
			this.onConnected();
		} else {
			this.connectionTimer = setTimeout(
				() => {
					this.connection.abort("timeout");
					this.stop("summarizerClientDisconnected");
				},
				2 * 60 * 1000,
			);
			this.runtime.once("connected", this.onConnected);
		}
	}

	/**
	 * Stops running.
	 */
	public stop(reason: SummarizerStopReason): void {
		if (!this.cancellation.signal.aborted) {
			this.connection.abort("stopped");
			this.clearConnectionTimer();
			this.runtime.off("connected", this.onConnected);
			this.runtime.off("disconnected", this.disconnected);
			this.runtime.off("dispose", this.disconnected);
			this.cancellation.abort(reason);
		}
	}

	private async waitForConnection(): Promise<"connected" | "stopped" | "timeout"> {
		if (!this.connection.signal.aborted) {
			await new Promise<void>((resolve) =>
				this.connection.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
		}
		return this.connection.signal.reason as "connected" | "stopped" | "timeout";
	}

	private clearConnectionTimer(): void {
		if (this.connectionTimer !== undefined) {
			clearTimeout(this.connectionTimer);
			this.connectionTimer = undefined;
		}
	}
}
