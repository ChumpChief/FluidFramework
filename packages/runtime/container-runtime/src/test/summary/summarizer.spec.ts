/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { strict as assert } from "node:assert";
import { Deferred } from "@fluidframework/core-utils/internal";
import { MockLogger } from "@fluidframework/telemetry-utils/internal";
import sinon from "sinon";
import {
	DefaultSummaryConfiguration,
	RunningSummarizer,
	Summarizer,
	type SummarizerConnection,
} from "../../summary/index.js";
import { RunWhileConnectedCoordinator } from "../../summary/index.js";

describe("Scoped child summarization", () => {
	afterEach(() => sinon.restore());
	function setup() {
		const disconnected = new AbortController();
		const connection: SummarizerConnection & { signal: AbortSignal } = {
			signal: disconnected.signal,
			ready: Promise.resolve("connected"),
			cancelled: false,
			waitCancelled: new Promise(() => {}),
			stop: sinon.stub(),
		};
		sinon
			.stub(RunWhileConnectedCoordinator, "open")
			.returns(connection as RunWhileConnectedCoordinator);
		const executor = {
			waitStop: sinon.stub().resolves(),
			dispose: sinon.stub(),
			on: sinon.stub(),
			off: sinon.stub(),
			disposed: false,
			summarizeOnDemand: sinon.stub(),
			enqueueSummarize: sinon.stub(),
		};
		const start = sinon
			.stub(RunningSummarizer, "start")
			.resolves(executor as unknown as RunningSummarizer);
		const dispose = sinon.stub();
		const runtime = {
			baseLogger: new MockLogger(),
			clientId: "child",
			deltaManager: { initialSequenceNumber: 0, lastSequenceNumber: 0 },
			disposeFn: dispose,
		} as unknown as ConstructorParameters<typeof Summarizer>[0];
		const summarizer = new Summarizer(
			runtime,
			() => DefaultSummaryConfiguration,
			{} as unknown as ConstructorParameters<typeof Summarizer>[2],
			{} as unknown as ConstructorParameters<typeof Summarizer>[3],
			{ createWatcher: sinon.stub() } as unknown as ConstructorParameters<
				typeof Summarizer
			>[4],
			() => true,
		);
		return { summarizer, executor, start, dispose, connection, disconnected, runtime };
	}
	it("awaits startup, returns work, drains, and releases without disposing its caller's container", async () => {
		const test = setup();
		const stop = new AbortController();
		const abort = new AbortController();
		const value = await test.summarizer.withSummarizer(
			{ onBehalfOf: "parent", stop: stop.signal, abort: abort.signal, allowLastSummary: true },
			async (client) => {
				assert.notEqual(client, test.executor, "commands must pass through the policy facade");
				stop.abort("parentNotConnected");
				return 42;
			},
		);
		assert.equal(value, 42);
		assert.deepEqual(test.executor.waitStop.args, [[true]]);
		assert.equal(test.executor.dispose.callCount, 1);
		assert.equal(test.dispose.callCount, 0);
	});
	it("waits for connection and executor startup before entering the callback", async () => {
		const test = setup();
		const start = new Deferred<RunningSummarizer>();
		test.start.returns(start.promise);
		const action = sinon.stub().resolves();
		const stop = new AbortController();
		const task = test.summarizer.withSummarizer(
			{
				onBehalfOf: undefined,
				stop: stop.signal,
				abort: stop.signal,
				allowLastSummary: false,
			},
			action,
		);
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(action.callCount, 0);
		start.resolve(test.executor as unknown as RunningSummarizer);
		await task;
		assert.equal(action.callCount, 1);
		assert.deepEqual(test.executor.waitStop.args, [[false]]);
	});
	it("propagates work failure and releases the executor", async () => {
		const test = setup();
		const signal = new AbortController().signal;
		await assert.rejects(
			test.summarizer.withSummarizer(
				{ onBehalfOf: undefined, stop: signal, abort: signal, allowLastSummary: false },
				async () => {
					throw new Error("Job failed");
				},
			),
			/Job failed/,
		);
		assert.equal(test.executor.dispose.callCount, 1);
		assert.equal(test.dispose.callCount, 0);
	});
	it("releases startup on abort and disposes an executor returned afterward", async () => {
		const test = setup();
		const abort = new AbortController();
		const start = new Deferred<RunningSummarizer>();
		test.start.returns(start.promise);
		const task = test.summarizer.withSummarizer(
			{
				onBehalfOf: undefined,
				stop: abort.signal,
				abort: abort.signal,
				allowLastSummary: false,
			},
			async () => {},
		);
		await new Promise((resolve) => process.nextTick(resolve));
		abort.abort(new Error("Cancelled"));
		await assert.rejects(task, /Cancelled/);
		start.resolve(test.executor as unknown as RunningSummarizer);
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(test.executor.dispose.callCount, 1);
	});
	it("does not allow two owners of the same child", async () => {
		const test = setup();
		const work = new Deferred<void>();
		const signal = new AbortController().signal;
		const options = {
			onBehalfOf: undefined,
			stop: signal,
			abort: signal,
			allowLastSummary: false,
		};
		const first = test.summarizer.withSummarizer(options, async () => work.promise);
		await assert.rejects(
			test.summarizer.withSummarizer(options, async () => {}),
			/already owned/,
		);
		work.resolve();
		await first;
	});

	it("ends scoped work on child disconnect without waiting for parent stop", async () => {
		const test = setup();
		const parent = new AbortController();
		const entered = new Deferred<void>();
		const task = test.summarizer.withSummarizer(
			{
				onBehalfOf: "parent",
				stop: parent.signal,
				abort: parent.signal,
				allowLastSummary: true,
			},
			async () => {
				entered.resolve();
				await new Promise(() => {});
			},
		);
		await entered.promise;
		test.disconnected.abort(new Error("Child disconnected"));
		await assert.rejects(task, /Child disconnected/);
		assert.equal(parent.signal.aborted, false);
		assert.equal(test.executor.dispose.callCount, 1);
	});

	it("enforces on-demand election permission within a scoped callback", async () => {
		const test = setup();
		Object.defineProperty(test.runtime, "summarizerClientId", { value: "another-summarizer" });
		const signal = new AbortController().signal;
		await test.summarizer.withSummarizer(
			{ onBehalfOf: undefined, stop: signal, abort: signal, allowLastSummary: false },
			async (client) => {
				assert.throws(
					() => client.summarizeOnDemand({ reason: "explicit" }),
					/elected summarizer is present/,
				);
			},
		);
		assert.equal(test.executor.summarizeOnDemand.callCount, 0);
	});

	it("drains an in-flight attempt after caller failure before releasing the executor", async () => {
		const test = setup();
		const drain = new Deferred<void>();
		const draining = new Deferred<void>();
		test.executor.waitStop.callsFake(async () => {
			draining.resolve();
			await drain.promise;
		});
		const signal = new AbortController().signal;
		const error = new Error("Caller failed");
		const task = test.summarizer.withSummarizer(
			{ onBehalfOf: undefined, stop: signal, abort: signal, allowLastSummary: true },
			async () => {
				throw error;
			},
		);
		const checked = assert.rejects(task, error);
		await draining.promise;
		assert.deepEqual(
			test.executor.waitStop.args,
			[[false]],
			"do not generate a last summary after caller failure",
		);
		assert.equal(test.executor.dispose.callCount, 0);
		drain.resolve();
		await checked;
		assert.equal(test.executor.dispose.callCount, 1);
	});

	it("aborts immediately without draining when resources become unavailable", async () => {
		const test = setup();
		const abort = new AbortController();
		const entered = new Deferred<void>();
		const task = test.summarizer.withSummarizer(
			{
				onBehalfOf: undefined,
				stop: abort.signal,
				abort: abort.signal,
				allowLastSummary: true,
			},
			async () => {
				entered.resolve();
				await new Promise(() => {});
			},
		);
		await entered.promise;
		abort.abort(new Error("Forced cancellation"));
		await assert.rejects(task, /Forced cancellation/);
		assert.equal(test.executor.waitStop.callCount, 0);
		assert.equal(test.executor.dispose.callCount, 1);
	});

	it("settles every pending legacy result when stopped before the request completes", async () => {
		const test = setup();
		const events: string[] = [];
		test.summarizer.on("summarizerStop", () => events.push("stopped"));
		test.dispose.callsFake(() => events.push("disposed"));
		const progress = test.summarizer.summarizeOnDemand({ reason: "legacy" });
		await new Promise((resolve) => process.nextTick(resolve));
		test.summarizer.stop("notElectedParent");
		const results = await Promise.all([
			progress.summarySubmitted,
			progress.summaryOpBroadcasted,
			progress.receivedSummaryAckOrNack,
		]);
		assert.deepEqual(
			results.map((result) => result.success),
			[false, false, false],
		);
		assert.equal(test.dispose.callCount, 1);
		assert.deepEqual(events, ["stopped", "disposed"]);
	});

	it("returns the original stop reason and settles pending results when legacy drain times out", async () => {
		const clock = sinon.useFakeTimers();
		const test = setup();
		test.executor.waitStop.returns(new Promise(() => {}));
		const run = test.summarizer.run("parent");
		await clock.tickAsync(0);
		test.summarizer.stop("parentNotConnected");
		await clock.tickAsync(2 * 60 * 1000);
		assert.equal(await run, "parentNotConnected");
		assert.equal(test.dispose.callCount, 1);
		assert.equal(clock.countTimers(), 0);
		const logger = test.runtime.baseLogger as MockLogger;
		logger.assertMatch([
			{ eventName: "Summarizer:StoppingSummarizer", reason: "parentNotConnected" },
			{ eventName: "Summarizer:SummarizerStopTimeout", timeoutMs: 2 * 60 * 1000 },
		]);
	});
});
