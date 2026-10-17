/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { SummarizerStopReason } from "@fluidframework/container-runtime-definitions/internal";
import type { ISummarizer } from "./summarizerTypes.js";

/**
 * Child execution lifetime. Its caller owns the container and the overall drain deadline.
 * @internal
 */
export interface SummaryExecution {
	readonly ready: Promise<void>;
	readonly closed: Promise<SummarizerStopReason>;
	stop(reason: SummarizerStopReason): void;
	summarizeOnDemand: ISummarizer["summarizeOnDemand"];
	enqueueSummarize: ISummarizer["enqueueSummarize"];
}

/**
 * Optional execution capability, adapted to ISummarizer only for older callers.
 * @internal
 */
export interface SummaryExecutionSource {
	openSummaryExecution(options: {
		onBehalfOf: string | undefined;
		allowLastSummary: boolean;
	}): SummaryExecution;
}
