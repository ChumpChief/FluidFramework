/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type { IEvent } from "@fluidframework/core-interfaces";
import sinon from "sinon";

import { RunWhileConnectedCoordinator } from "../../summary/index.js";

interface RuntimeEvents extends IEvent {
	(event: "connected" | "disconnected" | "dispose", listener: () => void): void;
}

describe("Run While Connected Coordinator", () => {
	it("owns its connection deadline and detaches all listeners on timeout", async () => {
		const clock = sinon.useFakeTimers();
		try {
			const runtime = new Runtime();
			const connection = RunWhileConnectedCoordinator.open(runtime, () => true);
			await clock.tickAsync(2 * 60 * 1000);
			await connection.ready;
			assert.equal(connection.timedOut, true);
			assert.equal(connection.cancelled, true);
			assertNoListeners(runtime);
			assert.equal(clock.countTimers(), 0);
		} finally {
			clock.restore();
		}
	});
	class Runtime extends TypedEventEmitter<RuntimeEvents> {
		public connected = false;
		public disposed = false;
		public clientId = "child";
	}

	function assertNoListeners(runtime: Runtime): void {
		for (const event of ["connected", "disconnected", "dispose"] as const) {
			assert.equal(runtime.listenerCount(event), 0, `retained ${event} listener`);
		}
	}

	it("can stop an immediately owned controller before it connects", async () => {
		const runtime = new Runtime();
		const coordinator = RunWhileConnectedCoordinator.open(runtime, () => true);
		coordinator.stop("notElectedParent");
		await coordinator.ready;
		assert.equal(await coordinator.waitCancelled, "notElectedParent");
		assertNoListeners(runtime);
	});

	it("detaches connection and disposal listeners when explicitly stopped", async () => {
		const runtime = new Runtime();
		runtime.connected = true;
		const coordinator = await RunWhileConnectedCoordinator.create(runtime, () => true);
		coordinator.stop("notElectedParent");
		coordinator.stop("parentNotConnected");
		assert.equal(await coordinator.waitCancelled, "notElectedParent");
		assertNoListeners(runtime);
	});

	it("releases startup and all listeners when disposed before connection", async () => {
		const runtime = new Runtime();
		const creation = RunWhileConnectedCoordinator.create(runtime, () => true);
		runtime.disposed = true;
		runtime.emit("dispose");
		const coordinator = await creation;
		assert.equal(coordinator.cancelled, true);
		assert.equal(await coordinator.waitCancelled, "summarizerClientDisconnected");
		assertNoListeners(runtime);
	});

	it("observes a connect/disconnect pair before the startup continuation runs", async () => {
		const runtime = new Runtime();
		const creation = RunWhileConnectedCoordinator.create(runtime, () => true);
		runtime.connected = true;
		runtime.emit("connected");
		runtime.connected = false;
		runtime.emit("disconnected");
		const coordinator = await creation;
		assert.equal(coordinator.cancelled, true);
		assertNoListeners(runtime);
	});

	it("retains only lifetime listeners after connection, then detaches on disconnect", async () => {
		const runtime = new Runtime();
		const creation = RunWhileConnectedCoordinator.create(runtime, () => true);
		runtime.connected = true;
		runtime.emit("connected");
		const coordinator = await creation;
		assert.equal(coordinator.cancelled, false);
		assert.equal(runtime.listenerCount("connected"), 0);
		runtime.connected = false;
		runtime.emit("disconnected");
		assert.equal(coordinator.cancelled, true);
		assertNoListeners(runtime);
	});
});
