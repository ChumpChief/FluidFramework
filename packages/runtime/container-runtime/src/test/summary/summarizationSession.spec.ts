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
		public summarizeOnDemand(): never {
			throw new Error("Not used by lifecycle tests");
		}
		public enqueueSummarize(): never {
			throw new Error("Not used by lifecycle tests");
		}
	}

	it("delivers the first graceful stop requested during creation and still allows run", async () => {
		const creation = new Deferred<ISummarizer>();
		const summarizer = new TestSummarizer();
		const session = new SummarizationSession(async () => creation.promise);
		session.stop("parentNotConnected");
		session.stop("notElectedParent");
		creation.resolve(summarizer);
		assert.equal(await session.loaded, summarizer);
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
		assert.equal(session.summarizer, undefined);
	});

	it("closes a late-created summarizer without running it", async () => {
		const creation = new Deferred<ISummarizer>();
		const summarizer = new TestSummarizer();
		const session = new SummarizationSession(async () => creation.promise);
		session.close();
		assert.equal(await session.loaded, undefined);
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

	it("observes a creation failure after closure", async () => {
		const creation = new Deferred<ISummarizer>();
		const session = new SummarizationSession(async () => creation.promise);
		session.close();
		assert.equal(await session.loaded, undefined);
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
			assert.equal(await session.loaded, undefined);
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
