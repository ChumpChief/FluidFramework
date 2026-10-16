/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { LoaderHeader } from "@fluidframework/container-definitions/internal";
import { DriverHeader } from "@fluidframework/driver-definitions/internal";
import sinon from "sinon";

import {
	getSummaryExecution,
	summaryClientCreateProps,
	summaryClientRequest,
} from "../summaryClient.js";

describe("Summary client loading policy", () => {
	it("preserves host request fields while enforcing the shared summary policy", () => {
		const request = {
			url: "https://example.com/document",
			headers: { custom: "value", [LoaderHeader.reconnect]: true },
		};
		const adapted = summaryClientRequest(request);
		const policy = summaryClientCreateProps();
		assert.equal(adapted.url, request.url);
		assert.equal(adapted.headers?.custom, "value");
		assert.equal(adapted.headers?.[LoaderHeader.reconnect], policy.canReconnect);
		assert.deepEqual(
			adapted.headers?.[LoaderHeader.clientDetails],
			policy.clientDetailsOverride,
		);
		assert.equal(adapted.headers?.[LoaderHeader.cache], false);
		assert.equal(adapted.headers?.[DriverHeader.summarizingClient], true);
		assert.equal(request.headers[LoaderHeader.reconnect], true);
	});

	it("uses dedicated discovery for host-triggered execution", async () => {
		const execution = {};
		const getEntryPoint = sinon.stub().rejects(new Error("Application entrypoint evaluated"));
		assert.equal(
			await getSummaryExecution({
				getEntryPoint,
				getSummaryExecution: async () => execution,
			}),
			execution,
		);
		assert.equal(getEntryPoint.callCount, 0);
	});

	it("retains entrypoint compatibility and respects authoritative absence", async () => {
		const execution = {};
		const getEntryPoint = sinon.stub().resolves(execution);
		assert.equal(await getSummaryExecution({ getEntryPoint }), execution);
		assert.equal(
			await getSummaryExecution({
				getEntryPoint,
				getSummaryExecution: async () => undefined,
			}),
			undefined,
		);
		assert.equal(getEntryPoint.callCount, 1);
	});
});
