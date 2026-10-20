/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type { ISummarizerEvents } from "@fluidframework/container-runtime-definitions/internal";
import { Deferred } from "@fluidframework/core-utils/internal";
import type { ISequencedClient } from "@fluidframework/driver-definitions";
import { MockLogger } from "@fluidframework/telemetry-utils/internal";
import sinon from "sinon";
import {
	type IConnectedEvents,
	type ISummarizer,
	SummarizerClientElection,
	SummaryManager,
	SummaryManagerState,
	summarizerClientType,
} from "../../summary/index.js";
import { TestQuorumClients } from "./testQuorumClients.js";

describe("Quorum summarizer creation integration", () => {
	let clock: sinon.SinonFakeTimers;
	const managers: SummaryManager[] = [];
	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});
	afterEach(() => {
		for (const manager of managers.splice(0)) {
			manager.dispose();
		}
		clock.restore();
	});

	class Connection extends TypedEventEmitter<IConnectedEvents> {
		public connected = true;
		constructor(public clientId: string) {
			super();
		}
		public disconnect(): void {
			this.connected = false;
			this.emit("disconnected");
		}
	}
	class Child extends TypedEventEmitter<ISummarizerEvents> implements ISummarizer {
		public readonly finished = new Deferred<void>();
		public readonly stop = sinon.stub();
		public readonly close = sinon.stub();
		public readonly summarizeOnDemand = sinon.stub();
		public readonly enqueueSummarize = sinon.stub();
		public readonly run = sinon.stub().callsFake(async () => {
			await this.finished.promise;
			return "summarizerClientDisconnected" as const;
		});
	}
	function setup() {
		const quorum = new TestQuorumClients();
		const logger = new MockLogger();
		let sequenceNumber = 0;
		function add(id: string, summarizer = false): void {
			const client: ISequencedClient = {
				sequenceNumber: ++sequenceNumber,
				client: {
					mode: "write",
					permission: [],
					scopes: [],
					user: { id },
					details: {
						capabilities: { interactive: !summarizer },
						type: summarizer ? summarizerClientType : undefined,
					},
				},
			};
			quorum.addClient(id, client);
		}
		function remove(id: string): void {
			sequenceNumber++;
			quorum.removeClient(id);
		}
		function election() {
			return new SummarizerClientElection(quorum);
		}
		function parent(id: string, delay = 0, initialDelay = 0) {
			const connection = new Connection(id);
			const observer = election();
			const requests: { child: Child; loaded: Deferred<ISummarizer> }[] = [];
			const manager = new SummaryManager(
				observer,
				connection,
				{ opsSinceLastAck: 5000, addOpListener: () => {}, removeOpListener: () => {} },
				logger,
				async () => {
					const request = { child: new Child(), loaded: new Deferred<ISummarizer>() };
					requests.push(request);
					return request.loaded.promise;
				},
				{
					recordAttemptAndGetDelay: () => delay,
					maxDelayMs: delay,
					numAttempts: 0,
				},
				{
					initialDelayMs: initialDelay,
					opsToBypassInitialDelay: initialDelay > 0 ? 10000 : 0,
				},
			);
			managers.push(manager);
			manager.start();
			return { manager, connection, observer, requests };
		}
		return { add, remove, parent, election, logger };
	}

	it("retries after creation rejects and runs the replacement", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a");
		await clock.tickAsync(0);
		const first = a.requests[0];
		assert(first !== undefined);
		first.loaded.reject(new Error("Creation failed"));
		await clock.tickAsync(0);
		const second = a.requests[1];
		assert(second !== undefined);
		test.add("s2", true);
		second.loaded.resolve(second.child);
		await clock.tickAsync(0);
		assert.equal(second.child.run.callCount, 1);
		assert.equal(a.manager.currentState, SummaryManagerState.Running);
		assert.equal(first.child.close.callCount, 0, "rejected creation supplied no owned child");
		second.child.finished.resolve();
		await clock.tickAsync(0);
	});

	it("releases ownership and retries even when close throws", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a");
		await clock.tickAsync(0);
		const first = a.requests[0];
		assert(first !== undefined);
		test.add("s1", true);
		first.loaded.resolve(first.child);
		await clock.tickAsync(0);
		first.child.close.callsFake(() => {
			assert.equal(a.manager.currentState, SummaryManagerState.Stopping);
			test.remove("s1");
			throw new Error("Close failed");
		});
		first.child.finished.resolve();
		await clock.tickAsync(0);
		assert.equal(first.child.listenerCount("summarize"), 0);
		assert.equal(first.child.close.callCount, 1);
		assert.equal(a.requests.length, 2);
		assert.equal(
			test.logger.events.filter(
				(event) => event.eventName === "SummaryManager:SummarizerCleanupException",
			).length,
			1,
		);
		const second = a.requests[1];
		assert(second !== undefined);
		test.add("s2", true);
		second.loaded.resolve(second.child);
		await clock.tickAsync(0);
		assert.equal(second.child.run.callCount, 1);
		second.child.finished.resolve();
		await clock.tickAsync(0);
	});

	it("cancels the old stop timer on normal completion before replacement", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a");
		await clock.tickAsync(0);
		const first = a.requests[0];
		assert(first !== undefined);
		test.add("s1", true);
		first.loaded.resolve(first.child);
		await clock.tickAsync(0);
		a.connection.disconnect();
		a.connection.connected = true;
		a.connection.emit("connected", "a");
		first.child.close.callsFake(() => test.remove("s1"));
		first.child.finished.resolve();
		await clock.tickAsync(0);
		assert.equal(clock.countTimers(), 0);
		const second = a.requests[1];
		assert(second !== undefined);
		test.add("s2", true);
		second.loaded.resolve(second.child);
		await clock.tickAsync(120000);
		assert.equal(second.child.close.callCount, 0);
		assert.equal(a.manager.currentState, SummaryManagerState.Running);
		assert.equal(
			test.logger.events.filter(
				(event) => event.eventName === "SummaryManager:SummarizerStopTimeout",
			).length,
			0,
		);
		second.child.finished.resolve();
		await clock.tickAsync(0);
	});

	it("cancels an armed stop timer when disposed", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a");
		await clock.tickAsync(0);
		const request = a.requests[0];
		assert(request !== undefined);
		test.add("s", true);
		request.loaded.resolve(request.child);
		await clock.tickAsync(0);
		a.connection.disconnect();
		assert.equal(clock.countTimers(), 1);
		a.manager.dispose();
		assert.equal(clock.countTimers(), 0);
		await clock.tickAsync(120000);
		assert.equal(request.child.close.callCount, 0);
		request.child.finished.resolve();
		await clock.tickAsync(0);
		assert.equal(request.child.close.callCount, 1);
		assert.equal(a.manager.currentState, SummaryManagerState.Idle);
		assert.equal(a.requests.length, 1);
	});

	it("releases the old child before synchronous close callbacks can start a replacement", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a");
		await clock.tickAsync(0);
		const first = a.requests[0];
		assert(first !== undefined);
		test.add("s1", true);
		first.loaded.resolve(first.child);
		await clock.tickAsync(0);
		let stateDuringClose: SummaryManagerState | undefined;
		first.child.close.callsFake(() => {
			stateDuringClose = a.manager.currentState;
			test.remove("s1");
			assert.equal(a.requests.length, 1, "close callbacks must not start a second owner");
		});
		first.child.finished.resolve();
		await clock.tickAsync(0);
		assert.equal(stateDuringClose, SummaryManagerState.Stopping);
		assert.equal(a.requests.length, 2);
		assert.equal(first.child.close.callCount, 1);
	});

	it("ignores a late run rejection after timeout and replacement", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a");
		await clock.tickAsync(0);
		const first = a.requests[0];
		assert(first !== undefined);
		test.add("s1", true);
		first.loaded.resolve(first.child);
		await clock.tickAsync(0);
		a.connection.disconnect();
		a.connection.connected = true;
		a.connection.emit("connected", "a");
		first.child.close.callsFake(() => test.remove("s1"));
		await clock.tickAsync(120000);
		const ended = test.logger.events.filter(
			(event) => event.eventName === "SummaryManager:RunningSummarizer_end",
		);
		assert.equal(ended.length, 1, "ownership interval ends at the stop deadline");
		assert.equal(ended[0].duration, 120000);
		assert.equal(
			test.logger.events.filter(
				(event) =>
					event.eventName === "SummaryManager:EndingSummarizer" &&
					event.reason === "summarizerStopTimeout",
			).length,
			1,
		);
		const second = a.requests[1];
		assert(second !== undefined);
		test.add("s2", true);
		second.loaded.resolve(second.child);
		await clock.tickAsync(0);
		const eventsBeforeLateFailure = test.logger.events.length;
		first.child.finished.reject(new Error("Late run failure"));
		await clock.tickAsync(0);
		assert.equal(
			test.logger.events.length,
			eventsBeforeLateFailure,
			"late failure does not emit manager errors or another ending event",
		);
		assert.equal(a.manager.currentState, SummaryManagerState.Running);
		assert.equal(first.child.close.callCount, 1);
		assert.equal(
			a.connection.listenerCount("disconnected"),
			1,
			"only the replacement lifecycle observes disconnect",
		);
		assert.equal(second.child.close.callCount, 0);
		assert.equal(first.child.listenerCount("summarize"), 0);
		second.child.finished.resolve();
		await clock.tickAsync(0);
		assert.equal(
			a.connection.listenerCount("disconnected"),
			0,
			"completed lifecycle removes its disconnect listener",
		);
	});

	for (const first of ["s1", "s2"]) {
		it(`waits for the last sequenced child departure during handoff (${first} leaves first)`, async () => {
			const test = setup();
			test.add("a");
			test.add("b");
			const a = test.parent("a");
			const b = test.parent("b");
			await clock.tickAsync(0);
			const request = a.requests[0];
			assert(request !== undefined);
			test.add("s1", true);
			request.loaded.resolve(request.child);
			await clock.tickAsync(0);
			assert.equal(request.child.run.callCount, 1);
			test.add("s2", true);
			const restored = test.election();
			test.remove("a");
			assert.equal(request.child.stop.callCount, 1);
			request.child.finished.resolve();
			await clock.tickAsync(0);
			assert.equal(b.requests.length, 0, "local completion does not authorize creation");
			test.remove(first);
			await clock.tickAsync(0);
			assert.equal(b.requests.length, 0, "idle remaining child blocks replacement");
			assert.equal(restored.hasSummarizer, b.observer.hasSummarizer);
			test.remove(first === "s1" ? "s2" : "s1");
			await clock.tickAsync(0);
			assert.equal(b.requests.length, 1);
			assert.equal(restored.hasSummarizer, false);
		});
	}

	it("runs the last-summary path after own-child join, disconnect and late load completion", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a");
		await clock.tickAsync(0);
		const request = a.requests[0];
		assert(request !== undefined);
		assert.equal(a.manager.currentState, SummaryManagerState.Loading);
		test.add("s", true);
		a.connection.disconnect();
		assert.equal(a.manager.currentState, SummaryManagerState.Stopping);
		request.loaded.resolve(request.child);
		await clock.tickAsync(0);
		assert.equal(request.child.run.callCount, 1);
		assert.equal(request.child.stop.firstCall.args[0], "parentNotConnected");
		assert.equal(a.manager.currentState, SummaryManagerState.Stopping);
		request.child.finished.resolve();
		await clock.tickAsync(0);
		assert.equal(a.requests.length, 1);
	});

	it("closes an in-flight child without running it after parent responsibility changes", async () => {
		const test = setup();
		test.add("a");
		test.add("b");
		const a = test.parent("a");
		const b = test.parent("b");
		await clock.tickAsync(0);
		const request = a.requests[0];
		assert(request !== undefined);
		test.add("s", true);
		test.remove("a");
		request.loaded.resolve(request.child);
		await clock.tickAsync(0);
		assert.equal(request.child.run.callCount, 0);
		assert.equal(request.child.close.callCount, 1);
		assert.equal(b.requests.length, 0);
		test.remove("s");
		await clock.tickAsync(0);
		assert.equal(b.requests.length, 1);
	});

	it("keeps the original stop intent when a disconnected parent reconnects during creation", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a");
		await clock.tickAsync(0);
		const request = a.requests[0];
		assert(request !== undefined);
		test.add("s", true);
		a.connection.disconnect();
		a.connection.connected = true;
		a.connection.emit("connected", "a");
		request.loaded.resolve(request.child);
		await clock.tickAsync(0);
		assert.equal(request.child.stop.firstCall.args[0], "parentNotConnected");
		assert.equal(request.child.run.callCount, 1);
		request.child.finished.resolve();
		await clock.tickAsync(0);
		assert.equal(a.requests.length, 1, "own child still in quorum blocks another request");
		test.remove("s");
		await clock.tickAsync(0);
		assert.equal(a.requests.length, 2);
	});

	it("does not issue a new creation after losing election during throttling", async () => {
		const test = setup();
		test.add("a");
		test.add("b");
		const a = test.parent("a", 100);
		test.remove("a");
		await clock.tickAsync(100);
		assert.equal(a.requests.length, 0);
	});

	it("permits high-op disconnected-parent recovery before creation", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a", 100);
		a.connection.disconnect();
		await clock.tickAsync(100);
		assert.equal(a.requests.length, 1);
	});

	it("skips low-op creation when disconnected during the initial delay", async () => {
		const test = setup();
		test.add("a");
		const a = test.parent("a", 0, 100);
		a.connection.disconnect();
		await clock.tickAsync(100);
		assert.equal(a.requests.length, 0);
	});

	it("waits for sequenced departure after forced local cleanup", async () => {
		const test = setup();
		test.add("a");
		test.add("b");
		const a = test.parent("a");
		const b = test.parent("b");
		await clock.tickAsync(0);
		const request = a.requests[0];
		assert(request !== undefined);
		test.add("s", true);
		request.loaded.resolve(request.child);
		await clock.tickAsync(0);
		test.remove("a");
		await clock.tickAsync(120000);
		assert.equal(request.child.close.callCount, 1);
		assert.equal(b.requests.length, 0);
		test.remove("s");
		await clock.tickAsync(0);
		assert.equal(b.requests.length, 1);
		request.child.finished.resolve();
		await clock.tickAsync(0);
	});
});
