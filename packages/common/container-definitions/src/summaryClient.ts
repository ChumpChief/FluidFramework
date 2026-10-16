/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { IContainer } from "./loader.js";

/**
 * Optional loader capability for opening a second client of the current document for summarization.
 * Runtime-specific execution is discovered separately; this capability only owns container creation.
 * @internal
 */
export interface SummaryClientLoader {
	/**
	 * Loads a non-interactive, non-reconnecting summarizer client for the current document.
	 * The caller owns disposal of the returned container, including when execution discovery fails.
	 */
	loadSummaryClient(): Promise<IContainer>;
}
