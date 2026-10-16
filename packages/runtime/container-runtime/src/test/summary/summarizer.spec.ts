/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import type { SummarizerStopReason } from "@fluidframework/container-runtime-definitions/internal";
import { Deferred } from "@fluidframework/core-utils/internal";
import { MockLogger } from "@fluidframework/telemetry-utils/internal";
import sinon from "sinon";

import {
	DefaultSummaryConfiguration,
	RunningSummarizer,
	Summarizer,
	type ICancellableSummarizerController,
} from "../../summary/index.js";

describe("Runtime", () => {
	describe("Summarization", () => {
		describe("Summarizer", () => {
			it("Should not run last summary when reason is not parentNotConnected", () => {
				const stopReasons: SummarizerStopReason[] = [
					"failToSummarize",
					"notElectedParent",
					"notElectedClient",
					"summarizerClientDisconnected",
					"summarizerException",
				];

				// This doesn't prevent future stop reason additions, but it's a good baseline
				for (const stopReason of stopReasons) {
					assert(
						Summarizer.stopReasonCanRunLastSummary(stopReason) === false,
						"should not run last summary when stop reason is not parentNotConnected",
					);
				}
			});

			it("Should run last summary when reason is parentNotConnected", () => {
				assert(
					Summarizer.stopReasonCanRunLastSummary("parentNotConnected") === true,
					"should run last summary when stop reason is parentNotConnected",
				);
			});

			describe("Shared child lifecycle", () => {
				let clock: sinon.SinonFakeTimers;
				beforeEach(() => {
					clock = sinon.useFakeTimers();
				});
				afterEach(() => {
					sinon.restore();
				});

				function createTestSummarizer() {
					const logger = new MockLogger();
					const cancellation = new Deferred<SummarizerStopReason>();
					let cancelled = false;
					const stop = sinon.stub().callsFake((reason: SummarizerStopReason) => {
						cancelled = true;
						cancellation.resolve(reason);
					});
					const controller: ICancellableSummarizerController = {
						get cancelled() {
							return cancelled;
						},
						waitCancelled: cancellation.promise,
						stop,
					};
					const createController = sinon.stub().resolves(controller);
					const dispose = sinon.stub();
					const runtime = {
						baseLogger: logger,
						clientId: "child",
						deltaManager: { initialSequenceNumber: 0, lastSequenceNumber: 0 },
						disposeFn: dispose,
					} as unknown as ConstructorParameters<typeof Summarizer>[0];
					const executor = {
						disposed: false,
						waitStop: sinon.stub().resolves(),
						dispose: sinon.stub(),
						on: sinon.stub(),
						off: sinon.stub(),
						summarizeOnDemand: sinon.stub(),
					};
					const start = sinon
						.stub(RunningSummarizer, "start")
						.resolves(executor as unknown as RunningSummarizer);
					const summarizer = new Summarizer(
						runtime,
						() => DefaultSummaryConfiguration,
						{} as unknown as ConstructorParameters<typeof Summarizer>[2],
						{} as unknown as ConstructorParameters<typeof Summarizer>[3],
						{ createWatcher: sinon.stub() } as unknown as ConstructorParameters<
							typeof Summarizer
						>[4],
						createController,
					);
					return {
						summarizer,
						createController,
						controller,
						stop,
						start,
						executor,
						dispose,
						logger,
					};
				}

				for (const mode of ["automatic", "on-demand"] as const) {
					it(`cleans up ${mode} executor startup failure and emits its terminal event before disposal`, async () => {
						const test = createTestSummarizer();
						const error = new Error("Executor startup failed");
						test.start.rejects(error);
						const events: string[] = [];
						test.summarizer.on("summarizerStop", ({ stopReason }) => {
							events.push(stopReason);
						});
						test.dispose.callsFake(() => events.push("disposed"));
						if (mode === "automatic") {
							await assert.rejects(test.summarizer.run("parent"), /Executor startup failed/);
						} else {
							const results = test.summarizer.summarizeOnDemand({ reason: "test" });
							const submitted = await results.summarySubmitted;
							assert.equal(submitted.success, false);
						}
						assert.deepEqual(events, ["summarizerException", "disposed"]);
						assert.equal(test.stop.calledWith("summarizerException"), true);
						assert.equal(clock.countTimers(), 0);
					});

					it(`does not start ${mode} execution after disposal during connection startup`, async () => {
						const test = createTestSummarizer();
						const creation = new Deferred<ICancellableSummarizerController>();
						test.createController.returns(creation.promise);
						const run = mode === "automatic" ? test.summarizer.run("parent") : undefined;
						if (mode === "on-demand") {
							test.summarizer.summarizeOnDemand({ reason: "test" });
						}
						test.summarizer.dispose();
						creation.resolve(test.controller);
						await clock.tickAsync(0);
						await run;
						assert.equal(test.start.callCount, 0);
						assert.equal(test.stop.calledWith("summarizerClientDisconnected"), true);
						assert.equal(clock.countTimers(), 0);
					});

					it(`clears connection and drain timers after ${mode} execution stops`, async () => {
						const test = createTestSummarizer();
						const run = mode === "automatic" ? test.summarizer.run("parent") : undefined;
						if (mode === "on-demand") {
							test.summarizer.summarizeOnDemand({ reason: "test" });
						}
						await clock.tickAsync(0);
						assert.equal(test.start.callCount, 1);
						assert.equal(clock.countTimers(), 0, "connection deadline is cleared");
						test.summarizer.stop("parentNotConnected");
						await clock.tickAsync(0);
						await run;
						assert.deepEqual(test.executor.waitStop.args, [[mode === "automatic"]]);
						assert.equal(clock.countTimers(), 0, "drain deadline is cleared");
						assert.equal(test.dispose.callCount, 1);
					});

					it(`bounds ${mode} connection startup and cancels a late controller`, async () => {
						const test = createTestSummarizer();
						const creation = new Deferred<ICancellableSummarizerController>();
						test.createController.returns(creation.promise);
						const run = mode === "automatic" ? test.summarizer.run("parent") : undefined;
						const results =
							mode === "on-demand"
								? test.summarizer.summarizeOnDemand({ reason: "test" })
								: undefined;
						await clock.tickAsync(2 * 60 * 1000);
						if (results === undefined) {
							assert.equal(await run, "summarizerClientDisconnected");
						} else {
							const submitted = await results.summarySubmitted;
							const ack = await results.receivedSummaryAckOrNack;
							assert.equal(submitted.success, false);
							assert.equal(ack.success, false);
						}
						assert.equal(test.dispose.callCount, 1);
						assert.equal(test.start.callCount, 0);
						creation.resolve(test.controller);
						await clock.tickAsync(0);
						assert.equal(test.stop.calledWith("summarizerClientDisconnected"), true);
					});

					it(`bounds ${mode} draining without changing its last-summary policy`, async () => {
						const test = createTestSummarizer();
						test.executor.waitStop.returns(new Promise(() => {}));
						const run = mode === "automatic" ? test.summarizer.run("parent") : undefined;
						if (mode === "on-demand") {
							test.summarizer.summarizeOnDemand({ reason: "test" });
						}
						await clock.tickAsync(0);
						test.summarizer.stop("parentNotConnected");
						await clock.tickAsync(2 * 60 * 1000);
						await run;
						assert.deepEqual(test.executor.waitStop.args, [[mode === "automatic"]]);
						assert.equal(test.dispose.callCount, 1);
						test.logger.assertMatch([{ eventName: "Summarizer:SummarizerStopTimeout" }]);
					});
				}

				it("shares connection and executor startup between simultaneous explicit requests", async () => {
					const test = createTestSummarizer();
					const creation = new Deferred<ICancellableSummarizerController>();
					test.createController.returns(creation.promise);
					const first = test.summarizer.summarizeOnDemand({ reason: "first" });
					const second = test.summarizer.summarizeOnDemand({ reason: "second" });
					assert.equal(test.createController.callCount, 1);
					creation.resolve(test.controller);
					await clock.tickAsync(0);
					assert.equal(test.start.callCount, 1);
					assert.equal(test.executor.summarizeOnDemand.callCount, 2);
					assert.deepEqual(test.executor.summarizeOnDemand.firstCall.args[0], {
						reason: "first",
					});
					assert.deepEqual(test.executor.summarizeOnDemand.secondCall.args[0], {
						reason: "second",
					});
					test.summarizer.stop("parentNotConnected");
					await clock.tickAsync(0);
					const firstResult = await first.summarySubmitted;
					const secondResult = await second.summarySubmitted;
					assert.equal(firstResult.success, false);
					assert.equal(secondResult.success, false);
					assert.deepEqual(test.executor.waitStop.args, [[false]]);
					assert.equal(test.dispose.callCount, 1);
				});

				it("lets an explicit request share automatic startup without changing last-summary policy", async () => {
					const test = createTestSummarizer();
					const creation = new Deferred<ICancellableSummarizerController>();
					test.createController.returns(creation.promise);
					const run = test.summarizer.run("parent");
					test.summarizer.summarizeOnDemand({ reason: "explicit" });
					creation.resolve(test.controller);
					await clock.tickAsync(0);
					assert.equal(test.createController.callCount, 1);
					assert.equal(test.start.callCount, 1);
					assert.equal(test.executor.summarizeOnDemand.callCount, 1);
					test.summarizer.stop("parentNotConnected");
					await clock.tickAsync(0);
					await run;
					assert.deepEqual(test.executor.waitStop.args, [[true]]);
					assert.equal(test.dispose.callCount, 1);
				});

				it("fails every waiting request when shared startup fails", async () => {
					const test = createTestSummarizer();
					const creation = new Deferred<ICancellableSummarizerController>();
					test.createController.returns(creation.promise);
					const first = test.summarizer.summarizeOnDemand({ reason: "first" });
					const second = test.summarizer.summarizeOnDemand({ reason: "second" });
					creation.reject(new Error("Connection failed"));
					await clock.tickAsync(0);
					const results = await Promise.all([
						first.receivedSummaryAckOrNack,
						second.receivedSummaryAckOrNack,
					]);
					assert.deepEqual(
						results.map((result) => result.success),
						[false, false],
					);
					assert.equal(test.dispose.callCount, 1);
					assert.equal(clock.countTimers(), 0);
				});
			});
		});
	});
});
