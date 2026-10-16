/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type {
	ISummarizerEvents,
	SummarizerStopReason,
} from "@fluidframework/container-runtime-definitions/internal";
import { Deferred } from "@fluidframework/core-utils/internal";
import sinon from "sinon";

import { type ISummarizer, SummarizationSession } from "../../summary/index.js";

describe("Summarization Session", () => {
	class TestSummarizer extends TypedEventEmitter<ISummarizerEvents> implements ISummarizer {
		public readonly runResult = new Deferred<SummarizerStopReason>();
		public readonly run = sinon
			.stub()
			.callsFake(async (_onBehalfOf: string) => this.runResult.promise);
		public readonly stop = sinon.stub<[SummarizerStopReason], void>();
		public readonly close = sinon.stub<[], void>();
		public readonly summarizeOnDemand = sinon.stub<
			Parameters<ISummarizer["summarizeOnDemand"]>,
			ReturnType<ISummarizer["summarizeOnDemand"]>
		>();
		public readonly enqueueSummarize = sinon.stub<
			Parameters<ISummarizer["enqueueSummarize"]>,
			ReturnType<ISummarizer["enqueueSummarize"]>
		>();
	}

	it("delivers the first graceful stop requested during creation and still allows run", async () => {
		const creation = new Deferred<ISummarizer>();
		const summarizer = new TestSummarizer();
		const session = new SummarizationSession(async () => creation.promise);
		session.stop("parentNotConnected");
		session.stop("notElectedParent");
		creation.resolve(summarizer);
		assert.equal(await session.loaded, true);
		assert.deepEqual(summarizer.stop.args, [["parentNotConnected"]]);
		const result = session.run("parent");
		summarizer.runResult.resolve("parentNotConnected");
		assert.equal(await result, "parentNotConnected");
		assert.deepEqual(await session.closed, {
			kind: "completed",
			reason: "parentNotConnected",
		});
		assert.deepEqual(summarizer.run.args, [["parent"]]);
		assert.equal(summarizer.close.callCount, 1);
		assert.equal(session.isLoaded, false);
	});

	it("closes a late-created summarizer without running it", async () => {
		const creation = new Deferred<ISummarizer>();
		const summarizer = new TestSummarizer();
		const session = new SummarizationSession(async () => creation.promise);
		session.close();
		assert.equal(await session.loaded, false);
		creation.resolve(summarizer);
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(await session.run("parent"), undefined);
		assert.equal(summarizer.run.callCount, 0);
		assert.equal(summarizer.close.callCount, 1);
	});

	it("closes a loaded summarizer if abandoned before run", async () => {
		const summarizer = new TestSummarizer();
		const session = new SummarizationSession(async () => summarizer);
		await session.loaded;
		session.close();
		session.close();
		assert.equal(await session.run("parent"), undefined);
		assert.equal(summarizer.run.callCount, 0);
		assert.equal(summarizer.close.callCount, 1);
	});

	it("releases the summarizer when execution fails", async () => {
		const error = new Error("Execution failed");
		const summarizer = new TestSummarizer();
		const session = new SummarizationSession(async () => summarizer);
		await session.loaded;
		const result = session.run("parent");
		summarizer.runResult.reject(error);
		await assert.rejects(result, error);
		assert.deepEqual(await session.closed, { kind: "failed", error });
		assert.equal(summarizer.close.callCount, 1);
	});

	it("reports creation failures", async () => {
		const error = new Error("Load failed");
		const session = new SummarizationSession(async () => {
			throw error;
		});
		await assert.rejects(session.loaded, error);
		assert.deepEqual(await session.closed, { kind: "failed", error });
		session.close();
	});

	it("forwards events from stop intent delivered during loading and detaches on closure", async () => {
		const creation = new Deferred<ISummarizer>();
		const summarizer = new TestSummarizer();
		const session = new SummarizationSession(async () => creation.promise);
		const reasons: SummarizerStopReason[] = [];
		session.on("summarizerStop", ({ stopReason }) => reasons.push(stopReason));
		summarizer.stop.callsFake((reason) => {
			summarizer.emit("summarizerStop", { stopReason: reason });
		});
		session.stop("parentNotConnected");
		creation.resolve(summarizer);
		await session.loaded;
		assert.deepEqual(reasons, ["parentNotConnected"]);
		session.close();
		assert.equal(summarizer.listenerCount("summarizerStop"), 0);
		summarizer.emit("summarizerStop", { stopReason: "notElectedParent" });
		assert.deepEqual(reasons, ["parentNotConnected"]);
	});

	it("delegates summary requests only while a child is loaded", async () => {
		const creation = new Deferred<ISummarizer>();
		const summarizer = new TestSummarizer();
		const session = new SummarizationSession(async () => creation.promise);
		const options = { reason: "explicit request" };
		assert.throws(() => session.summarizeOnDemand(options), /not loaded or has closed/);
		assert.throws(() => session.enqueueSummarize(options), /not loaded or has closed/);
		creation.resolve(summarizer);
		await session.loaded;
		session.summarizeOnDemand(options);
		session.enqueueSummarize(options);
		assert.deepEqual(summarizer.summarizeOnDemand.args, [[options]]);
		assert.deepEqual(summarizer.enqueueSummarize.args, [[options]]);
		session.close();
		assert.throws(() => session.summarizeOnDemand(options), /not loaded or has closed/);
		assert.throws(() => session.enqueueSummarize(options), /not loaded or has closed/);
	});

	it("observes a creation failure after closure", async () => {
		const creation = new Deferred<ISummarizer>();
		const session = new SummarizationSession(async () => creation.promise);
		session.close();
		assert.equal(await session.loaded, false);
		creation.reject(new Error("Late load failure"));
		await new Promise((resolve) => process.nextTick(resolve));
	});

	it("bounds graceful stopping during creation and closes a late result", async () => {
		const clock = sinon.useFakeTimers();
		try {
			const creation = new Deferred<ISummarizer>();
			const summarizer = new TestSummarizer();
			const session = new SummarizationSession(async () => creation.promise);
			session.stop("parentNotConnected");
			await clock.tickAsync(2 * 60 * 1000);
			assert.deepEqual(await session.closed, {
				kind: "timeout",
				reason: "parentNotConnected",
			});
			assert.equal(await session.loaded, false);
			creation.resolve(summarizer);
			await clock.tickAsync(0);
			assert.equal(summarizer.close.callCount, 1);
			assert.equal(summarizer.run.callCount, 0);
		} finally {
			clock.restore();
		}
	});

	it("settles run at the stop deadline even if the underlying run never completes", async () => {
		const clock = sinon.useFakeTimers();
		try {
			const summarizer = new TestSummarizer();
			const session = new SummarizationSession(async () => summarizer);
			await session.loaded;
			const run = session.run("parent");
			session.stop("notElectedParent");
			await clock.tickAsync(2 * 60 * 1000);
			assert.equal(await run, undefined);
			const outcome = await session.closed;
			assert.deepEqual(outcome, { kind: "timeout", reason: "notElectedParent" });
			summarizer.runResult.reject(new Error("Late execution failure"));
			await clock.tickAsync(0);
			assert.equal(await session.closed, outcome);
			assert.equal(summarizer.close.callCount, 1);
			assert.equal(clock.countTimers(), 0);
		} finally {
			clock.restore();
		}
	});

	it("clears the stop deadline when graceful execution completes", async () => {
		const clock = sinon.useFakeTimers();
		try {
			const summarizer = new TestSummarizer();
			const session = new SummarizationSession(async () => summarizer);
			await session.loaded;
			const run = session.run("parent");
			session.stop("parentNotConnected");
			summarizer.runResult.resolve("parentNotConnected");
			await run;
			assert.equal(clock.countTimers(), 0);
			const outcome = await session.closed;
			assert.equal(outcome.kind, "completed");
		} finally {
			clock.restore();
		}
	});
});
