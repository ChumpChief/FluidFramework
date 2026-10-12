/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { MockFluidDataStoreRuntime } from "@fluidframework/test-runtime-utils/internal";

import { isISharedObjectHandle, SharedObjectHandle } from "../handle.js";

describe("isISharedObjectHandle", () => {
	it("should return true for a SharedObjectHandle class instance", () => {
		const sharedObjectHandle = new SharedObjectHandle(
			{ isAttached: () => false, bindToContext: () => {} },
			{},
			"object",
			new MockFluidDataStoreRuntime(),
		);
		assert.strictEqual(
			isISharedObjectHandle(sharedObjectHandle),
			true,
			"Valid handle should return true.",
		);
	});

	it("should return false for a function", () => {
		// Even though functions have a bind method!
		assert.strictEqual(
			isISharedObjectHandle(() => {}),
			false,
			"Function should return false.",
		);
	});

	it("should return false for an object without a bind method", () => {
		const invalidHandle = {
			// Missing bind method
		};
		assert.strictEqual(
			isISharedObjectHandle(invalidHandle),
			false,
			"Handle without bind method should return false.",
		);
	});

	it("should return false for a non-handle object with a bind function", () => {
		const invalidHandle = {
			bind: () => {},
		};
		assert.strictEqual(
			isISharedObjectHandle(invalidHandle),
			false,
			"Object with bind method but not a handle should return false.",
		);
	});

	it("should return false for null", () => {
		// eslint-disable-next-line unicorn/no-null
		assert.strictEqual(isISharedObjectHandle(null), false, "Null should return false.");
	});

	it("should return false for undefined", () => {
		assert.strictEqual(
			isISharedObjectHandle(undefined),
			false,
			"Undefined should return false.",
		);
	});

	it("should return false for a string", () => {
		assert.strictEqual(
			isISharedObjectHandle("not a handle"),
			false,
			"String should return false.",
		);
	});

	it("should return false for a number", () => {
		assert.strictEqual(isISharedObjectHandle(123), false, "Number should return false.");
	});

	it("should return false for a boolean", () => {
		assert.strictEqual(isISharedObjectHandle(true), false, "Boolean should return false.");
	});

	it("should return false for an empty object", () => {
		assert.strictEqual(isISharedObjectHandle({}), false, "Empty object should return false.");
	});

	it("should return false for an array", () => {
		assert.strictEqual(isISharedObjectHandle([]), false, "Array should return false.");
	});
});

describe("SharedObjectHandle entry point", () => {
	it("resolves the value but attaches the channel", async () => {
		let attached = false;
		let binds = 0;
		const channel = {
			isAttached: () => attached,
			bindToContext: () => {
				binds++;
				attached = true;
			},
		};
		const value = { data: 42 };
		const handle = new SharedObjectHandle(
			channel,
			value,
			"cell",
			new MockFluidDataStoreRuntime(),
		);
		assert.equal(await handle.get(), value);
		assert.equal(handle.isAttached, false);
		handle.attachGraph();
		handle.attachGraph();
		assert.equal(binds, 1);
		assert.equal(handle.isAttached, true);
		assert.equal(await handle.get(), value);
	});
});
