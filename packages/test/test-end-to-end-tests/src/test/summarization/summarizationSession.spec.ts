/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";

import { describeCompat } from "@fluid-private/test-version-utils";
import { LoaderHeader } from "@fluidframework/container-definitions/internal";
import type { SummaryExecutionProvider } from "@fluidframework/container-definitions/internal";
import type { ISummarizer } from "@fluidframework/container-runtime/internal";
import type { FluidObject } from "@fluidframework/core-interfaces";
import { SummarizationSession } from "@fluidframework/container-runtime/internal/test/summary";
import {
	createSummarizer,
	getContainerEntryPointBackCompat,
	type ITestContainerConfig,
	type ITestFluidObject,
} from "@fluidframework/test-utils/internal";

describeCompat("Owned summarization session", "NoCompat", (getProvider) => {
	for (const mode of ["automatic", "explicit"] as const) {
		it(`executes a job through an ${mode} session on a real second client and round-trips its summary`, async () => {
			const provider = getProvider({ syncSummarizer: true });
			const config: ITestContainerConfig = {
				runtimeOptions: { summaryOptions: { summaryConfigOverrides: { state: "disabled" } } },
			};
			const parent = await provider.makeTestContainer(config);
			const data = await getContainerEntryPointBackCompat<ITestFluidObject>(parent);
			const { container: child } = await createSummarizer(provider, parent);
			data.root.set("session-job", "persisted");
			await provider.ensureSynchronized();
			const session = new SummarizationSession(async () => {
				const execution = await (
					child as typeof child & SummaryExecutionProvider
				).getSummaryExecution();
				assert(execution !== undefined);
				const summarizer = (execution as FluidObject<ISummarizer>).ISummarizer;
				assert(summarizer !== undefined);
				return summarizer;
			});
			try {
				if (mode === "automatic") {
					assert(parent.clientId !== undefined);
					session.start(parent.clientId);
				}
				const results = await session.requestSummary({ reason: "session-round-trip" });
				assert.deepEqual(await session.ready, { kind: "ready" });
				const ack = await results.receivedSummaryAckOrNack;
				assert(ack.success, "the session summary must be acknowledged");
				const version = ack.data.summaryAckOp.contents.handle;
				session.stop("parentNotConnected");
				const closed = await session.closed;
				assert.equal(closed.kind, "completed");
				assert.equal(child.disposed, true, "the session releases its child container");
				const loaded = await provider.loadTestContainer(config, {
					[LoaderHeader.version]: version,
				});
				const restored = await getContainerEntryPointBackCompat<ITestFluidObject>(loaded);
				assert.equal(restored.root.get("session-job"), "persisted");
			} finally {
				session.close();
			}
		});
	}
});
