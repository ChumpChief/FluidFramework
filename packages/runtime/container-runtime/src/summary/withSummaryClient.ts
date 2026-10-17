/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { ISummarizer } from "./summarizerTypes.js";
import { untilAborted } from "./summaryExecution.js";

/**
 * Runs work inside a second client's resource scope. A late load is closed after cancellation.
 * There are no independent loading, readiness, or completion notifications: await this function.
 */
export async function withSummaryClient<T>(
	load: (signal?: AbortSignal) => Promise<ISummarizer>,
	signal: AbortSignal,
	action: (client: ISummarizer) => Promise<T>,
): Promise<T> {
	signal.throwIfAborted();
	const ownership = new AbortController();
	const abort = (): void => ownership.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	let child: ISummarizer | undefined;
	try {
		child = await untilAborted(
			load(ownership.signal).then((loaded) => {
				if (ownership.signal.aborted) {
					loaded.close();
					ownership.signal.throwIfAborted();
				}
				return loaded;
			}),
			ownership.signal,
		);
		if (child === undefined) {
			throw new Error("Summary client did not load");
		}
		return await untilAborted(action(child), ownership.signal);
	} finally {
		signal.removeEventListener("abort", abort);
		try {
			child?.close();
		} finally {
			ownership.abort();
		}
	}
}
