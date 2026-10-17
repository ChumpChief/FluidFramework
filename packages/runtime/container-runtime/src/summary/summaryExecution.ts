/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { SummarizerStopReason } from "@fluidframework/container-runtime-definitions/internal";
import type { ISummarizer } from "./summarizerTypes.js";

/**
 * Summary commands available within a connected child's resource scope.
 * Do not retain the client beyond the callback or launch work that the callback does not await.
 * @internal
 */
export type SummaryClient = Pick<ISummarizer, "summarizeOnDemand" | "enqueueSummarize">;

/**
 * Runs work with a connected summary client. Returning from the callback drains and releases it.
 * The caller owns the container and supplies cancellation separately from graceful stopping.
 * Ordinary callback failures drain existing summary work before propagating the failure.
 * Abort skips draining; non-cancellable startup can finish later and is disposed on arrival.
 * @internal
 */
export interface SummaryExecutionSource {
	withSummarizer<T>(
		options: {
			onBehalfOf: string | undefined;
			stop: AbortSignal;
			abort: AbortSignal;
			allowLastSummary: boolean;
			/** False for a host that intentionally releases the client at broadcast rather than acknowledgment. */
			drain?: boolean;
		},
		action: (client: SummaryClient) => Promise<T>,
	): Promise<T>;
}

/** Adapts an external abort event to an awaited operation, removing the listener afterward. */
export async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort: () => void = () => {};
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				onAbort = () =>
					reject(
						signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
					);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) {
					onAbort();
				}
			}),
		]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Waits for an external stop request; this does not start or complete another lifecycle. */
export async function waitForStop(signal: AbortSignal): Promise<SummarizerStopReason> {
	if (!signal.aborted) {
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
	}
	return signal.reason as SummarizerStopReason;
}
