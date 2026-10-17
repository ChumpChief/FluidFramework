/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { strict as assert } from "node:assert";
import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type { ISummarizerEvents } from "@fluidframework/container-runtime-definitions/internal";
import { Deferred } from "@fluidframework/core-utils/internal";
import sinon from "sinon";
import { type ISummarizer, withSummaryClient } from "../../summary/index.js";

describe("Scoped summary client", () => {
	function child(): ISummarizer & { close: sinon.SinonStub } {
		return Object.assign(new TypedEventEmitter<ISummarizerEvents>(), {
			close: sinon.stub(),
			stop: sinon.stub(),
			run: sinon.stub().resolves("parentNotConnected"),
			summarizeOnDemand: sinon.stub(),
			enqueueSummarize: sinon.stub(),
		});
	}
	it("returns the callback result and releases the child in finally", async () => {
		const client = child();
		const result = await withSummaryClient(
			async () => client,
			new AbortController().signal,
			async (loaded) => {
				assert.equal(loaded, client);
				assert.equal(client.close.callCount, 0);
				return 42;
			},
		);
		assert.equal(result, 42);
		assert.equal(client.close.callCount, 1);
	});
	it("releases the child when the callback throws", async () => {
		const client = child();
		const error = new Error("Summary failed");
		await assert.rejects(
			withSummaryClient(
				async () => client,
				new AbortController().signal,
				async () => {
					throw error;
				},
			),
			error,
		);
		assert.equal(client.close.callCount, 1);
	});
	it("does not load after cancellation", async () => {
		const abort = new AbortController();
		abort.abort(new Error("Cancelled"));
		const load = sinon.stub();
		await assert.rejects(
			withSummaryClient(load, abort.signal, async () => {}),
			/Cancelled/,
		);
		assert.equal(load.callCount, 0);
	});
	it("releases a pending load immediately and closes its late child", async () => {
		const loading = new Deferred<ISummarizer>();
		const abort = new AbortController();
		const client = child();
		const action = sinon.stub().resolves();
		const task = withSummaryClient(async () => loading.promise, abort.signal, action);
		abort.abort(new Error("Cancelled"));
		await assert.rejects(task, /Cancelled/);
		loading.resolve(client);
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(client.close.callCount, 1);
		assert.equal(action.callCount, 0);
	});
	it("closes the owned child when pending work is cancelled and observes late failure", async () => {
		const work = new Deferred<void>();
		const client = child();
		const abort = new AbortController();
		const started = new Deferred<void>();
		const task = withSummaryClient(
			async () => client,
			abort.signal,
			async () => {
				started.resolve();
				await work.promise;
			},
		);
		await started.promise;
		abort.abort(new Error("Cancelled"));
		await assert.rejects(task, /Cancelled/);
		assert.equal(client.close.callCount, 1);
		work.reject(new Error("Late failure"));
		await new Promise((resolve) => process.nextTick(resolve));
	});
});
