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
	createSummarizationSessionFactory,
	formCreateSummarizerFn,
	SummarizationSession,
} from "../../summary/index.js";

describe("Summarizer loading ownership", () => {
	it("opens independent sessions without starting loader work until after ownership is returned", async () => {
		const first = createLoader(async () => ({}));
		const second = createLoader(async () => ({}));
		const resolve = sinon.stub();
		resolve.onFirstCall().returns(first.resolution.promise);
		resolve.onSecondCall().returns(second.resolution.promise);
		const openSession = createSummarizationSessionFactory({ resolve } as unknown as ILoader);
		const firstSession = openSession();
		const secondSession = openSession();
		assert.notEqual(firstSession, secondSession);
		assert.equal(resolve.callCount, 0);
		await new Promise((resolveTick) => process.nextTick(resolveTick));
		assert.equal(resolve.callCount, 2);
		firstSession.close();
		first.resolution.resolve(first.container);
		await new Promise((resolveTick) => process.nextTick(resolveTick));
		assert.equal(first.dispose.callCount, 1);
		assert.equal(second.dispose.callCount, 0);
		secondSession.close();
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
		const session = new SummarizationSession(formCreateSummarizerFn(test.loader));
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(test.resolve.callCount, 1);
		session.close();
		assert.equal(await session.loaded, false);
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
		const session = new SummarizationSession(formCreateSummarizerFn(test.loader));
		test.resolution.resolve(test.container);
		await entryPointStarted.promise;
		session.close();
		assert.equal(test.dispose.callCount, 1);
		assert.equal(await session.loaded, false);
		entryPoint.reject(new Error("Discovery failed after disposal"));
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(test.dispose.callCount, 1);
	});

	it("does not start a loader request for a session closed before creation starts", async () => {
		const test = createLoader(async () => ({}));
		const openSession = createSummarizationSessionFactory(test.loader);
		const session = openSession();
		session.close();
		assert.equal(await session.loaded, false);
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
