/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import type { IContainer, ILoader } from "@fluidframework/container-definitions/internal";
import type { FluidObject } from "@fluidframework/core-interfaces";
import { Deferred } from "@fluidframework/core-utils/internal";
import sinon from "sinon";

import {
	createSummaryClientScope,
	formCreateSummarizerFn,
	withSummaryClient,
} from "../../summary/index.js";

describe("Summarizer loading ownership", () => {
	it("discovers execution through its dedicated capability without evaluating the app entrypoint", async () => {
		const getEntryPoint = sinon.stub().rejects(new Error("App entrypoint must not run"));
		const test = createLoader(getEntryPoint);
		const execution = { ISummarizer: {} };
		const getSummaryExecution = sinon.stub().resolves(execution);
		Object.assign(test.container, { getSummaryExecution });
		const load = formCreateSummarizerFn(test.loader)();
		test.resolution.resolve(test.container);
		assert.equal(await load, execution.ISummarizer);
		assert.equal(getEntryPoint.callCount, 0);
		assert.equal(getSummaryExecution.callCount, 1);
	});

	it("does not fall back to an application entrypoint when dedicated execution is absent", async () => {
		const getEntryPoint = sinon.stub().resolves({ ISummarizer: {} });
		const test = createLoader(getEntryPoint);
		Object.assign(test.container, { getSummaryExecution: async () => undefined });
		const load = formCreateSummarizerFn(test.loader)();
		test.resolution.resolve(test.container);
		await assert.rejects(load, /does not implement ISummarizer/);
		assert.equal(getEntryPoint.callCount, 0);
		assert.equal(test.dispose.callCount, 1);
	});
	it("uses explicit summary-client loading when available without issuing a resolve request", async () => {
		const test = createLoader(async () => ({ ISummarizer: {} }));
		const loadSummaryClient = sinon.stub().resolves(test.container);
		const loader = { ...test.loader, loadSummaryClient };
		const controller = new AbortController();
		const child = await formCreateSummarizerFn(loader)(controller.signal);
		assert.notEqual(child, undefined);
		assert.equal(loadSummaryClient.callCount, 1);
		assert.equal(test.resolve.callCount, 0);
		controller.abort();
		assert.equal(test.dispose.callCount, 1);
	});

	it("propagates explicit loading failure without retrying through the legacy resolve path", async () => {
		const test = createLoader(async () => ({}));
		const error = new Error("Summary client load failed");
		const loader = { ...test.loader, loadSummaryClient: sinon.stub().rejects(error) };
		await assert.rejects(formCreateSummarizerFn(loader)(), error);
		assert.equal(test.resolve.callCount, 0);
	});
	it("owns independent loader scopes and releases each container", async () => {
		const first = createLoader(async () => ({}));
		const second = createLoader(async () => ({}));
		const resolve = sinon.stub();
		resolve.onFirstCall().returns(first.resolution.promise);
		resolve.onSecondCall().returns(second.resolution.promise);
		const openSession = createSummaryClientScope({ resolve } as unknown as ILoader);
		const firstAbort = new AbortController();
		const secondAbort = new AbortController();
		const firstTask = openSession(firstAbort.signal, async () => {});
		const secondTask = openSession(secondAbort.signal, async () => {});
		await new Promise((resolveTick) => process.nextTick(resolveTick));
		assert.equal(resolve.callCount, 2);
		firstAbort.abort(new Error("Cancelled"));
		await assert.rejects(firstTask, /Cancelled/);
		first.resolution.resolve(first.container);
		await new Promise((resolveTick) => process.nextTick(resolveTick));
		assert.equal(first.dispose.callCount, 1);
		assert.equal(second.dispose.callCount, 0);
		secondAbort.abort(new Error("Cancelled"));
		await assert.rejects(secondTask, /Cancelled/);
		second.resolution.resolve(second.container);
		await new Promise((resolveTick) => process.nextTick(resolveTick));
		assert.equal(second.dispose.callCount, 1);
	});

	function createLoader(getEntryPoint: () => Promise<FluidObject>) {
		const dispose = sinon.stub();
		let disposed = false;
		const container = {
			get disposed() {
				return disposed;
			},
			dispose: () => {
				disposed = true;
				dispose();
			},
			getEntryPoint,
		} as unknown as IContainer;
		const resolution = new Deferred<IContainer>();
		const resolve = sinon.stub().returns(resolution.promise);
		const loader = { resolve } as unknown as ILoader;
		return { container, dispose, resolution, resolve, loader };
	}

	it("disposes a container when entrypoint discovery fails", async () => {
		const error = new Error("Entrypoint failed");
		const test = createLoader(async () => {
			throw error;
		});
		const load = formCreateSummarizerFn(test.loader)();
		test.resolution.resolve(test.container);
		await assert.rejects(load, error);
		assert.equal(test.dispose.callCount, 1);
	});

	it("disposes a container whose entrypoint does not provide a summarizer", async () => {
		const test = createLoader(async () => ({}));
		const load = formCreateSummarizerFn(test.loader)();
		test.resolution.resolve(test.container);
		await assert.rejects(load, /does not implement ISummarizer/);
		assert.equal(test.dispose.callCount, 1);
	});

	it("disposes a container returned after its owning session closes", async () => {
		const getEntryPoint = sinon.stub().resolves({});
		const test = createLoader(getEntryPoint);
		const abort = new AbortController();
		const task = withSummaryClient(
			formCreateSummarizerFn(test.loader),
			abort.signal,
			async () => {},
		);
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(test.resolve.callCount, 1);
		abort.abort(new Error("Cancelled"));
		await assert.rejects(task, /Cancelled/);
		test.resolution.resolve(test.container);
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(test.dispose.callCount, 1);
		assert.equal(getEntryPoint.callCount, 0);
	});

	it("disposes immediately when a session closes during stalled entrypoint discovery", async () => {
		const entryPoint = new Deferred<FluidObject>();
		const entryPointStarted = new Deferred<void>();
		const test = createLoader(async () => {
			entryPointStarted.resolve();
			return entryPoint.promise;
		});
		const abort = new AbortController();
		const task = withSummaryClient(
			formCreateSummarizerFn(test.loader),
			abort.signal,
			async () => {},
		);
		test.resolution.resolve(test.container);
		await entryPointStarted.promise;
		abort.abort(new Error("Cancelled"));
		assert.equal(test.dispose.callCount, 1);
		await assert.rejects(task, /Cancelled/);
		entryPoint.reject(new Error("Discovery failed after disposal"));
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(test.dispose.callCount, 1);
	});

	it("does not start a loader request for a session closed before creation starts", async () => {
		const test = createLoader(async () => ({}));
		const openSession = createSummaryClientScope(test.loader);
		const abort = new AbortController();
		abort.abort(new Error("Cancelled"));
		await assert.rejects(
			openSession(abort.signal, async () => {}),
			/Cancelled/,
		);
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(test.resolve.callCount, 0);
	});

	it("retains the resolved container until the signal aborts after successful discovery", async () => {
		const child = { ISummarizer: {} };
		const test = createLoader(async () => child);
		const controller = new AbortController();
		const load = formCreateSummarizerFn(test.loader)(controller.signal);
		test.resolution.resolve(test.container);
		assert.equal(await load, child.ISummarizer);
		assert.equal(test.dispose.callCount, 0);
		controller.abort();
		assert.equal(test.dispose.callCount, 1);
	});

	it("disposes a legacy container when its summarizer request fails", async () => {
		const dispose = sinon.stub();
		const loader = {
			resolve: async () => ({
				disposed: false,
				dispose,
				request: async () => ({ status: 404, mimeType: "text/plain", value: "Not found" }),
			}),
		} as unknown as ILoader;
		await assert.rejects(formCreateSummarizerFn(loader)());
		assert.equal(dispose.callCount, 1);
	});
});
