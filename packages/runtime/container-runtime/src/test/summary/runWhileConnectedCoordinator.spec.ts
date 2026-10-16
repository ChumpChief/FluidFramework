/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type { IEvent } from "@fluidframework/core-interfaces";

import { RunWhileConnectedCoordinator } from "../../summary/index.js";

interface RuntimeEvents extends IEvent {
	(event: "connected" | "disconnected" | "dispose", listener: () => void): void;
}

describe("Run While Connected Coordinator", () => {
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
