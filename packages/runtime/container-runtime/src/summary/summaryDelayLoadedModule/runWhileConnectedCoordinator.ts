/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { SummarizerStopReason } from "@fluidframework/container-runtime-definitions/internal";
import { assert, Deferred } from "@fluidframework/core-utils/internal";

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
	readonly ready: Promise<void>;
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
	public readonly ready: Promise<void>;
	private _cancelled = false;
	private readonly stopDeferred = new Deferred<SummarizerStopReason>();
	private readonly disconnected = (): void => this.stop("summarizerClientDisconnected");
	private readonly connected = new Deferred<void>();
	private readonly onConnected = (): void => this.connected.resolve();

	public get cancelled(): boolean {
		if (!this._cancelled) {
			assert(this.active(), 0x25d /* "We should never connect as 'read'" */);

			// This check can't be enabled in current design due to lastSummary flow, where
			// summarizer for closed container stays around and can produce one more summary.
			// Currently we solve the problem of overlapping summarizer by doing wait in
			// SummaryManager.createSummarizer()
			// Better solution would involve these steps:
			// 1. Summarizer selection logic should chose summarizing client (with clientType === "summarizer")
			// if such client exists.
			// 2. Summarizer should be updated about such changes (to update onBehalfOfClientId)
			//
			// assert(this.runtime.summarizerClientId === this.onBehalfOfClientId ||
			//    this.runtime.summarizerClientId === this.runtime.clientId, "onBehalfOfClientId");
		}

		return this._cancelled;
	}

	/**
	 * Returns a promise that resolves once stopped either externally or by disconnect.
	 */
	public get waitCancelled(): Promise<SummarizerStopReason> {
		return this.stopDeferred.promise;
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
		this.ready = this.waitStart();
	}

	/**
	 * Starts and waits for a promise which resolves when connected.
	 * The promise will also resolve if stopped either externally or by disconnect.
	 *
	 * We only listen on disconnected event for clientType === "summarizer" container!
	 * And only do it here - no other place should check it! That way we have only one place
	 * that controls policy and it's easy to change policy in the future if we want to!
	 * We do not listen for "main" (aka interactive) container disconnect here, as it's
	 * responsibility of SummaryManager to decide if that's material or not. There are cases
	 * like "lastSummary", or main client experiencing nacks / disconnects due to hitting limit
	 * of non-summarized ops, where can make determination to continue with summary even if main
	 * client is disconnected.
	 */
	protected async waitStart(): Promise<void> {
		if (this.runtime.disposed) {
			this.stop("summarizerClientDisconnected");
			return;
		}

		this.runtime.once("dispose", this.disconnected);
		// Observe disconnection before waiting so a connect/disconnect pair in one turn cannot be missed.
		this.runtime.once("disconnected", this.disconnected);

		if (!this.runtime.connected) {
			this.runtime.once("connected", this.onConnected);
			await Promise.race([this.connected.promise, this.waitCancelled]);
			this.runtime.off("connected", this.onConnected);
		}
	}

	/**
	 * Stops running.
	 */
	public stop(reason: SummarizerStopReason): void {
		if (!this._cancelled) {
			this._cancelled = true;
			this.runtime.off("connected", this.onConnected);
			this.runtime.off("disconnected", this.disconnected);
			this.runtime.off("dispose", this.disconnected);
			this.stopDeferred.resolve(reason);
		}
	}
}
