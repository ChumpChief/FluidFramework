/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	SimpleCell,
	type SimpleCellOperation,
	type SimpleCellSnapshot,
} from "../simpleCell.js";

interface Replica<T> {
	cell: SimpleCell<T>;
	connected: boolean;
	cursor: number;
	readonly pending: Submission<T>[];
	readonly resubmitting: Submission<T>[];
}

interface Submission<T> {
	readonly sender: Replica<T>;
	readonly operation: SimpleCellOperation<T>;
}

/**
 * An ordered in-memory host, with no Fluid runtime mocks.
 * Submission records act as stable transport identities across retries and replica restarts.
 */
class OrderedHost<T> {
	private readonly replicas: Replica<T>[] = [];
	private readonly history: Submission<T>[] = [];
	private queue: Submission<T>[] = [];

	public add(snapshot: SimpleCellSnapshot<T> = {}): Replica<T> {
		const replica: Replica<T> = {
			cell: new SimpleCell(snapshot),
			connected: true,
			cursor: this.history.length,
			pending: [],
			resubmitting: [],
		};
		replica.cell.startReplication((operation) => this.submit(replica, operation));
		this.replicas.push(replica);
		return replica;
	}

	private submit(replica: Replica<T>, operation: SimpleCellOperation<T>): void {
		let submission = replica.resubmitting.shift();
		if (submission === undefined) {
			submission = { sender: replica, operation };
			replica.pending.push(submission);
		} else {
			assert.deepEqual(operation, submission.operation);
		}
		if (
			replica.connected &&
			!this.queue.includes(submission) &&
			!this.history.includes(submission)
		) {
			this.queue.push(submission);
		}
	}

	public sequence(): void {
		const submission = this.queue.shift();
		assert(submission !== undefined, "Expected an operation to sequence");
		this.history.push(submission);
	}

	public deliver(): void {
		for (const replica of this.replicas) {
			while (replica.connected && replica.cursor < this.history.length) {
				const submission = this.history[replica.cursor++];
				assert(submission !== undefined);
				const local = submission.sender === replica;
				if (local) {
					assert.equal(replica.pending.shift(), submission);
				}
				replica.cell.receive(submission.operation, local);
			}
		}
	}

	public flush(): void {
		this.deliver();
		while (this.queue.length > 0) {
			this.sequence();
			this.deliver();
		}
	}

	public disconnect(replica: Replica<T>): void {
		replica.connected = false;
		this.queue = this.queue.filter((entry) => entry.sender !== replica);
	}

	public reconnect(replica: Replica<T>): void {
		replica.connected = true;
		this.deliver();
		replica.resubmitting.push(...replica.pending);
		for (const { operation } of [...replica.pending]) {
			replica.cell.resubmit(structuredClone(operation));
		}
		assert.equal(replica.resubmitting.length, 0);
	}

	public rollback(replica: Replica<T>): void {
		const submission = replica.pending.at(-1);
		assert(submission !== undefined);
		assert(!this.history.includes(submission), "Cannot withdraw a sequenced operation");
		this.queue = this.queue.filter((entry) => entry !== submission);
		replica.pending.pop();
		replica.cell.rollback();
	}

	public restart(replica: Replica<T>): void {
		assert(!replica.connected, "Disconnect before restarting");
		const snapshot = structuredClone(replica.cell.getSnapshot());
		const operations = structuredClone(replica.cell.getPendingOperations());
		replica.cell = new SimpleCell(snapshot);
		replica.cell.startReplication((operation) => this.submit(replica, operation));
		replica.resubmitting.push(...replica.pending);
		for (const operation of operations) {
			replica.cell.replay(operation);
		}
		assert.equal(replica.resubmitting.length, 0);
	}
}

function recordEvents<T>(cell: SimpleCell<T>): SimpleCellOperation<T>[] {
	const events: SimpleCellOperation<T>[] = [];
	cell.events.on("valueChanged", (value) => events.push({ type: "set", value }));
	cell.events.on("delete", () => events.push({ type: "delete" }));
	return events;
}

function collectSubmissions<T>(cell: SimpleCell<T>): SimpleCellOperation<T>[] {
	const submissions: SimpleCellOperation<T>[] = [];
	cell.startReplication((operation) => submissions.push(operation));
	return submissions;
}

describe("SimpleCell", () => {
	describe("local use and events", () => {
		it("works without a host and does not accumulate pending operations", () => {
			const cell = new SimpleCell<number>();
			const events = recordEvents(cell);
			assert(cell.empty());
			cell.set(1);
			assert.equal(cell.get(), 1);
			assert(!cell.empty());
			cell.set(1);
			cell.delete();
			cell.delete();
			assert(cell.empty());
			assert.deepEqual(cell.getPendingOperations(), []);
			assert.deepEqual(events, [
				{ type: "set", value: 1 },
				{ type: "set", value: 1 },
				{ type: "delete" },
				{ type: "delete" },
			]);
		});

		it("keeps values opaque, including values a JSON host could not encode", () => {
			const value = { action: (): number => 42, values: new Map([["key", 1]]) };
			const cell = new SimpleCell<typeof value>();
			cell.set(value);
			assert.equal(cell.get(), value);
			assert.equal(cell.getSnapshot().value, value);
			assert.equal(cell.get()?.action(), 42);
		});

		it("distinguishes set(undefined) from delete events", () => {
			const cell = new SimpleCell<number | undefined>();
			const events = recordEvents(cell);
			cell.set(undefined);
			assert(cell.empty());
			cell.delete();
			assert.deepEqual(events, [{ type: "set", value: undefined }, { type: "delete" }]);
		});

		it("restores empty and populated snapshots without pending edits", () => {
			for (const snapshot of [{}, { value: undefined }, { value: 1 }]) {
				const cell = new SimpleCell<number>(snapshot);
				assert.equal(cell.get(), snapshot.value);
				assert.deepEqual(cell.getPendingOperations(), []);
				const restored = new SimpleCell(structuredClone(cell.getSnapshot()));
				assert.equal(restored.get(), cell.get());
			}
		});

		it("supports unsubscription, registration order, and listener changes during delivery", () => {
			const cell = new SimpleCell<number>();
			const calls: string[] = [];
			const late = (): void => {
				calls.push("late");
			};
			const removed = (): void => {
				calls.push("removed");
			};
			const first = (): void => {
				calls.push("first");
				cell.events.off("valueChanged", removed);
				cell.events.on("valueChanged", late);
			};
			const off = cell.events.on("valueChanged", first);
			cell.events.on("valueChanged", removed);
			cell.set(1);
			assert.deepEqual(calls, ["first"]);
			off();
			off();
			cell.set(2);
			assert.deepEqual(calls, ["first", "late"]);
		});

		it("rejects duplicate registration without faulting the Cell", () => {
			const cell = new SimpleCell<number>();
			const listener = (): void => {};
			cell.events.on("delete", listener);
			assert.throws(() => cell.events.on("delete", listener), /same listener object twice/);
			cell.events.off("delete", listener);
			cell.set(1);
			assert.equal(cell.get(), 1);
		});
	});

	describe("replication", () => {
		it("starts replication from local state without submitting old edits", () => {
			const first = new SimpleCell<number>();
			first.set(1);
			first.set(2);
			const submissions: SimpleCellOperation<number>[] = [];
			const initial = first.startReplication((submitted) => submissions.push(submitted));
			assert.deepEqual(initial, { value: 2 });
			assert.deepEqual(submissions, []);
			const second = new SimpleCell(initial);
			second.startReplication(() => {});
			first.set(3);
			const [operation] = submissions;
			assert(operation !== undefined);
			second.receive(operation, false);
			assert.equal(second.get(), 3);
			assert.throws(() => first.startReplication(() => {}), /already started/);
		});

		it("converges for concurrent sets and deletes while protecting pending local values", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			const firstEvents = recordEvents(first.cell);
			const secondEvents = recordEvents(second.cell);
			first.cell.set(1);
			second.cell.set(2);
			second.cell.delete();
			host.sequence();
			host.deliver();
			assert.equal(first.cell.get(), 1);
			assert(second.cell.empty());
			assert.deepEqual(second.cell.getSnapshot(), { value: 1 });
			host.sequence();
			host.deliver();
			assert.equal(first.cell.get(), 2);
			assert(second.cell.empty());
			host.flush();
			assert(first.cell.empty());
			assert(second.cell.empty());
			assert.deepEqual(first.cell.getPendingOperations(), []);
			assert.deepEqual(second.cell.getPendingOperations(), []);
			assert.deepEqual(firstEvents, [
				{ type: "set", value: 1 },
				{ type: "set", value: 2 },
				{ type: "delete" },
			]);
			assert.deepEqual(secondEvents, [{ type: "set", value: 2 }, { type: "delete" }]);
		});

		it("delivers remote set(undefined) as a set, not a delete", () => {
			const host = new OrderedHost<number | undefined>();
			const first = host.add();
			const second = host.add();
			const events = recordEvents(second.cell);
			first.cell.set(undefined);
			first.cell.delete();
			host.flush();
			assert.deepEqual(events, [{ type: "set", value: undefined }, { type: "delete" }]);
		});

		it("converges for every set/delete combination and ordering of two edits per replica", () => {
			const orders = [
				[0, 0, 1, 1],
				[0, 1, 0, 1],
				[0, 1, 1, 0],
				[1, 0, 0, 1],
				[1, 0, 1, 0],
				[1, 1, 0, 0],
			];
			for (const order of orders) {
				for (let combination = 0; combination < 16; combination++) {
					const host = new OrderedHost<number>();
					const replicas = [host.add(), host.add()];
					const edits = combination.toString(2).padStart(order.length, "0");
					const operations = order.map((sender, index): SimpleCellOperation<number> => {
						const replica = replicas[sender];
						assert(replica !== undefined);
						if (edits[index] === "1") {
							replica.cell.set(index);
							return { type: "set", value: index };
						}
						replica.cell.delete();
						return { type: "delete" };
					});
					for (const operation of operations) {
						host.sequence();
						host.deliver();
						const value = operation.type === "set" ? operation.value : undefined;
						for (const { cell } of replicas) {
							assert.deepEqual(cell.getSnapshot(), { value });
							const pending = cell.getPendingOperations().at(-1);
							assert.equal(
								cell.get(),
								pending === undefined
									? value
									: pending.type === "set"
										? pending.value
										: undefined,
							);
						}
					}
					assert.equal(replicas[0]?.cell.get(), replicas[1]?.cell.get());
					assert(replicas.every(({ cell }) => cell.getPendingOperations().length === 0));
				}
			}
		});

		it("publishes outer edits before edits nested in listeners", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			const events = recordEvents(second.cell);
			first.cell.events.on("valueChanged", (value) => {
				if (value === 1) {
					first.cell.set(2);
				}
			});
			first.cell.set(1);
			assert.equal(first.cell.get(), 2);
			host.flush();
			assert.equal(second.cell.get(), 2);
			assert.deepEqual(events, [
				{ type: "set", value: 1 },
				{ type: "set", value: 2 },
			]);
		});

		it("supports a local edit made while processing a remote event", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			second.cell.events.on("valueChanged", (value) => {
				if (value === 1) {
					second.cell.delete();
				}
			});
			first.cell.set(1);
			host.flush();
			assert(first.cell.empty());
			assert(second.cell.empty());
		});

		it("requires replication for sequenced delivery, resubmission, and rollback", () => {
			const cell = new SimpleCell<number>();
			const operation: SimpleCellOperation<number> = { type: "set", value: 1 };
			for (const call of [
				() => cell.receive(operation, false),
				() => cell.receive(operation, true),
				() => cell.resubmit(operation),
				() => cell.rollback(),
			]) {
				assert.throws(call, /has not started/);
			}
			cell.set(2);
			assert.equal(cell.get(), 2);
		});

		it("acknowledges pending edits in order without changing the optimistic value", () => {
			const cell = new SimpleCell<number>();
			const submissions = collectSubmissions(cell);
			assert.throws(
				() => cell.receive({ type: "set", value: 1 }, true),
				/without a pending operation/,
			);
			cell.set(1);
			cell.set(2);
			const [first, second] = submissions;
			assert(first !== undefined && second !== undefined);
			assert.deepEqual(cell.getSnapshot(), { value: undefined });
			assert.equal(cell.getPendingOperations().length, 2);
			cell.receive(first, true);
			assert.equal(cell.get(), 2);
			assert.deepEqual(cell.getSnapshot(), { value: 1 });
			assert.deepEqual(cell.getPendingOperations(), [{ type: "set", value: 2 }]);
			cell.receive(second, true);
			assert.deepEqual(cell.getSnapshot(), { value: 2 });
			assert.deepEqual(cell.getPendingOperations(), []);
			assert.throws(() => cell.receive(second, true), /without a pending operation/);
			cell.receive({ type: "set", value: 3 }, false);
			assert.equal(cell.get(), 3);
		});
	});

	describe("operation parsing", () => {
		it("interprets host-decoded contents while leaving payload values opaque", () => {
			const cell = new SimpleCell();
			collectSubmissions(cell);
			const events = recordEvents(cell);
			const payload = { type: "delete" };
			const content: unknown = { type: "set", value: payload };
			cell.receive(content, false);
			assert.equal(cell.get(), payload);
			assert.equal(cell.getSnapshot().value, payload);
			cell.receive({ type: "set" }, false);
			assert(cell.empty());
			cell.receive({ type: "delete" }, false);
			assert.deepEqual(events, [
				{ type: "set", value: payload },
				{ type: "set", value: undefined },
				{ type: "delete" },
			]);
		});

		it("rejects malformed contents before changing state, acknowledging, or publishing", () => {
			const cell = new SimpleCell<number>({ value: 0 });
			const submissions = collectSubmissions(cell);
			const events = recordEvents(cell);
			cell.set(1);
			const pending = cell.getPendingOperations();
			const invalidContents: unknown[] = [
				undefined,
				// eslint-disable-next-line unicorn/no-null -- JSON operations can decode to null.
				null,
				1,
				"set",
				[],
				{},
				{ type: 1 },
				{ type: "unknown" },
			];
			for (const content of invalidContents) {
				for (const call of [
					() => cell.receive(content, false),
					() => cell.receive(content, true),
					() => cell.resubmit(content),
					() => cell.replay(content),
				]) {
					assert.throws(call, TypeError);
					assert.equal(cell.get(), 1);
					assert.deepEqual(cell.getSnapshot(), { value: 0 });
					assert.deepEqual(cell.getPendingOperations(), pending);
					assert.deepEqual(submissions, [{ type: "set", value: 1 }]);
					assert.deepEqual(events, [{ type: "set", value: 1 }]);
				}
			}
			cell.receive({ type: "set", value: 1 }, true);
			cell.receive({ type: "set", value: 2 }, false);
			assert.equal(cell.get(), 2);
		});

		it("rejects malformed local-only replay without faulting the Cell", () => {
			const cell = new SimpleCell<number>({ value: 1 });
			assert.throws(() => cell.replay({ type: "unknown" }), TypeError);
			assert.deepEqual(cell.getSnapshot(), { value: 1 });
			assert.deepEqual(cell.getPendingOperations(), []);
			cell.replay({ type: "set", value: 2 });
			assert.equal(cell.get(), 2);
		});
	});

	describe("reconnection and replay", () => {
		it("replays local-only edits without publication and begins submitting after replication starts", () => {
			const cell = new SimpleCell<number | undefined>();
			const events = recordEvents(cell);
			cell.replay({ type: "set", value: 1 });
			cell.replay({ type: "delete" });
			cell.replay({ type: "set" });
			assert(cell.empty());
			cell.replay({ type: "set", value: 2 });
			assert.deepEqual(cell.getSnapshot(), { value: 2 });
			assert.deepEqual(cell.getPendingOperations(), []);
			assert.deepEqual(events, [
				{ type: "set", value: 1 },
				{ type: "delete" },
				{ type: "set", value: undefined },
				{ type: "set", value: 2 },
			]);

			const submissions = collectSubmissions(cell);
			assert.deepEqual(submissions, []);
			cell.replay({ type: "set", value: 3 });
			assert.deepEqual(submissions, [{ type: "set", value: 3 }]);
			assert.deepEqual(cell.getPendingOperations(), submissions);
			assert.deepEqual(cell.getSnapshot(), { value: 2 });
			cell.receive({ type: "set", value: 3 }, true);
			assert.deepEqual(cell.getSnapshot(), { value: 3 });
			assert.equal(events.length, 5);
		});

		it("resubmits several supplied operations before acknowledgments without reapplying edits", () => {
			const cell = new SimpleCell<number>();
			const submissions = collectSubmissions(cell);
			const events = recordEvents(cell);
			cell.set(1);
			cell.delete();
			cell.set(2);
			const originals = [...submissions];
			for (const operation of originals) {
				cell.resubmit(structuredClone(operation));
			}
			assert.deepEqual(submissions, [...originals, ...originals]);
			assert.deepEqual(events, originals);
			assert.equal(cell.get(), 2);
			assert.deepEqual(cell.getSnapshot(), { value: undefined });
			assert.deepEqual(cell.getPendingOperations(), originals);
			for (const operation of originals) {
				cell.receive(operation, true);
				assert.deepEqual(cell.getSnapshot(), {
					value: operation.type === "set" ? operation.value : undefined,
				});
			}
			assert.deepEqual(cell.getPendingOperations(), []);
		});

		it("queues offline edits and resubmits after catching up with remote changes", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			host.disconnect(first);
			first.cell.set(1);
			first.cell.delete();
			second.cell.set(2);
			host.flush();
			assert(first.cell.empty());
			assert.equal(second.cell.get(), 2);
			host.reconnect(first);
			assert(first.cell.empty());
			assert.deepEqual(first.cell.getSnapshot(), { value: 2 });
			host.flush();
			assert(first.cell.empty());
			assert(second.cell.empty());
			assert.deepEqual(first.cell.getPendingOperations(), []);
		});

		it("resends an edit lost before sequencing exactly once", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			const events = recordEvents(second.cell);
			first.cell.set(1);
			host.disconnect(first);
			host.reconnect(first);
			host.reconnect(first);
			host.flush();
			assert.equal(first.cell.get(), 1);
			assert.equal(second.cell.get(), 1);
			assert.deepEqual(events, [{ type: "set", value: 1 }]);
		});

		it("does not resend an edit sequenced before disconnection but not acknowledged", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			const events = recordEvents(second.cell);
			first.cell.set(1);
			host.sequence();
			host.disconnect(first);
			host.deliver();
			host.reconnect(first);
			host.flush();
			assert.deepEqual(first.cell.getPendingOperations(), []);
			assert.deepEqual(events, [{ type: "set", value: 1 }]);
		});

		it("restores a sequenced snapshot and pending edits with host-owned transport identity", () => {
			const host = new OrderedHost<number>();
			const first = host.add({ value: 0 });
			const second = host.add({ value: 0 });
			host.disconnect(first);
			first.cell.set(1);
			first.cell.delete();
			first.cell.set(3);
			const originalSubmissions = [...first.pending];
			assert.deepEqual(first.cell.getSnapshot(), { value: 0 });
			host.restart(first);
			assert.equal(first.cell.get(), 3);
			assert.deepEqual(first.cell.getSnapshot(), { value: 0 });
			assert(first.pending.every((entry, index) => entry === originalSubmissions[index]));
			second.cell.set(2);
			host.flush();
			host.reconnect(first);
			host.flush();
			assert.equal(first.cell.get(), 3);
			assert.equal(second.cell.get(), 3);
			assert.deepEqual(first.cell.getPendingOperations(), []);
		});

		it("acknowledges an edit sequenced before restart without resending it", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			const events = recordEvents(second.cell);
			first.cell.set(1);
			host.sequence();
			host.disconnect(first);
			first.cell.set(2);
			host.restart(first);
			host.reconnect(first);
			assert.deepEqual(first.cell.getSnapshot(), { value: 1 });
			assert.equal(first.cell.get(), 2);
			host.flush();
			assert.equal(second.cell.get(), 2);
			assert.deepEqual(first.cell.getPendingOperations(), []);
			assert.deepEqual(events, [
				{ type: "set", value: 1 },
				{ type: "set", value: 2 },
			]);
		});

		it("keeps identical pending edits distinct across replay and repeated resubmission", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			const events = recordEvents(second.cell);
			host.disconnect(first);
			first.cell.set(1);
			first.cell.set(1);
			const originalSubmissions = [...first.pending];
			host.restart(first);
			host.reconnect(first);
			host.reconnect(first);
			assert.equal(first.pending.length, 2);
			assert(first.pending.every((entry, index) => entry === originalSubmissions[index]));
			host.flush();
			assert.deepEqual(events, [
				{ type: "set", value: 1 },
				{ type: "set", value: 1 },
			]);
			assert.deepEqual(first.cell.getPendingOperations(), []);
			assert.equal(first.cell.get(), second.cell.get());
		});

		it("copies replay and pending operation records without cloning payloads", () => {
			const cell = new SimpleCell<{ count: number }>();
			collectSubmissions(cell);
			const value = { count: 1 };
			const operation = { type: "set" as const, value };
			cell.replay(operation);
			operation.value = { count: 2 };
			const [pending] = cell.getPendingOperations();
			assert(pending?.type === "set");
			assert.equal(pending.value, value);
			assert.notEqual(pending, cell.getPendingOperations()[0]);
			assert.equal(cell.get(), value);
		});
	});

	describe("rollback", () => {
		it("rolls back a set to empty and continues processing remote edits", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			const events = recordEvents(first.cell);
			first.cell.set(1);
			host.rollback(first);
			assert(first.cell.empty());
			assert.deepEqual(first.cell.getPendingOperations(), []);
			second.cell.set(2);
			host.flush();
			assert.equal(first.cell.get(), 2);
			assert.deepEqual(events, [
				{ type: "set", value: 1 },
				{ type: "delete" },
				{ type: "set", value: 2 },
			]);
		});

		it("rolls back nested pending sets and deletes in reverse order", () => {
			const host = new OrderedHost<number>();
			const first = host.add({ value: 0 });
			const second = host.add({ value: 0 });
			first.cell.set(1);
			first.cell.delete();
			first.cell.set(2);
			host.rollback(first);
			assert(first.cell.empty());
			host.rollback(first);
			assert.equal(first.cell.get(), 1);
			host.flush();
			assert.equal(first.cell.get(), 1);
			assert.equal(second.cell.get(), 1);
			assert.deepEqual(first.cell.getPendingOperations(), []);
		});

		it("reveals remote state received underneath pending edits", () => {
			const host = new OrderedHost<number>();
			const first = host.add({ value: 0 });
			const second = host.add({ value: 0 });
			second.cell.set(2);
			first.cell.set(1);
			host.sequence();
			host.deliver();
			assert.equal(first.cell.get(), 1);
			host.rollback(first);
			assert.equal(first.cell.get(), 2);
			assert.deepEqual(first.cell.getSnapshot(), { value: 2 });
			host.flush();
			assert.equal(second.cell.get(), 2);
		});

		it("restores an acknowledged local edit when a later edit is rolled back", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			first.cell.set(1);
			first.cell.delete();
			host.sequence();
			host.deliver();
			host.rollback(first);
			assert.equal(first.cell.get(), 1);
			assert.deepEqual(first.cell.getPendingOperations(), []);
		});

		it("rolls back newest edits first and rejects rollback with no pending edits", () => {
			const cell = new SimpleCell<number>();
			collectSubmissions(cell);
			assert.throws(() => cell.rollback(), /without a pending operation/);
			cell.set(1);
			cell.set(2);
			assert.equal(cell.get(), 2);
			assert.equal(cell.getPendingOperations().length, 2);
			cell.rollback();
			assert.equal(cell.get(), 1);
			assert.deepEqual(cell.getPendingOperations(), [{ type: "set", value: 1 }]);
			cell.rollback();
			assert(cell.empty());
			assert.deepEqual(cell.getPendingOperations(), []);
			assert.throws(() => cell.rollback(), /without a pending operation/);
			cell.receive({ type: "set", value: 3 }, false);
			assert.equal(cell.get(), 3);
		});

		it("registers an edit made during rollback notification as new pending work", () => {
			const host = new OrderedHost<number>();
			const first = host.add();
			const second = host.add();
			first.cell.events.on("delete", () => first.cell.set(2));
			first.cell.set(1);
			host.rollback(first);
			host.flush();
			assert.equal(first.cell.get(), 2);
			assert.equal(second.cell.get(), 2);
		});
	});

	describe("failure handling", () => {
		function assertFaulted(cell: SimpleCell<number>, cause: unknown): void {
			for (const call of [
				() => cell.set(2),
				() => cell.delete(),
				() => cell.startReplication(() => {}),
				() => cell.receive({ type: "set", value: 2 }, false),
				() => cell.receive({ type: "set", value: 2 }, true),
				() => cell.resubmit({ type: "set", value: 2 }),
				() => cell.replay({ type: "delete" }),
				() => cell.receive(undefined, false),
				() => cell.resubmit(undefined),
				() => cell.replay(undefined),
				() => cell.rollback(),
				() => cell.getSnapshot(),
				() => cell.getPendingOperations(),
			]) {
				assert.throws(
					call,
					(error: unknown) =>
						error instanceof Error &&
						error.message === "SimpleCell is faulted" &&
						error.cause === cause,
				);
			}
			assert.doesNotThrow(() => cell.get());
			assert.doesNotThrow(() => cell.empty());
		}

		it("registers state before publication and faults if publication throws", () => {
			const cell = new SimpleCell<number>();
			const failure = new Error("Host could not accept the operation");
			const events = recordEvents(cell);
			cell.startReplication((operation) => {
				assert.equal(cell.get(), 1);
				assert.deepEqual(cell.getPendingOperations(), [operation]);
				throw failure;
			});
			assert.throws(
				() => cell.set(1),
				(error: unknown) => error === failure,
			);
			assert.equal(cell.get(), 1);
			assert.deepEqual(events, []);
			assertFaulted(cell, failure);
		});

		it("faults if resubmission throws", () => {
			const cell = new SimpleCell<number>();
			const failure = new Error("Resubmission failed");
			let original: SimpleCellOperation<number> | undefined;
			cell.startReplication((operation) => {
				if (original !== undefined) {
					throw failure;
				}
				original = operation;
			});
			cell.set(1);
			assert(original !== undefined);
			const originalOperation = original;
			assert.throws(
				() => cell.resubmit(originalOperation),
				(error: unknown) => error === failure,
			);
			assertFaulted(cell, failure);
		});

		it("publishes before notifying listeners and faults on a listener exception", () => {
			const cell = new SimpleCell<number>();
			const submissions = collectSubmissions(cell);
			const failure = new Error("Listener failed");
			const calls: number[] = [];
			cell.events.on("valueChanged", () => {
				assert.equal(submissions.length, 1);
				calls.push(1);
				throw failure;
			});
			cell.events.on("valueChanged", () => calls.push(2));
			assert.throws(
				() => cell.set(1),
				(error: unknown) => error === failure,
			);
			assert.deepEqual(calls, [1]);
			assertFaulted(cell, failure);
		});

		it("faults on local-only, remote, replay, and rollback listener exceptions", () => {
			for (const source of ["local", "remote", "replay", "rollback"] as const) {
				const cell = new SimpleCell<number>();
				const failure = new Error(`${source} listener failed`);
				if (source !== "local") {
					collectSubmissions(cell);
				}
				if (source === "rollback") {
					cell.set(1);
				}
				cell.events.on("delete", () => {
					throw failure;
				});
				const run = (): void => {
					switch (source) {
						case "local": {
							cell.delete();
							break;
						}
						case "remote": {
							cell.receive({ type: "delete" }, false);
							break;
						}
						case "replay": {
							cell.replay({ type: "delete" });
							break;
						}
						case "rollback": {
							cell.rollback();
							break;
						}
						default: {
							assert.fail("Unexpected source");
						}
					}
				};
				assert.throws(run, (error: unknown) => error === failure);
				assertFaulted(cell, failure);
			}
		});

		it("keeps the first fault even if a listener catches a nested failure", () => {
			const cell = new SimpleCell<number>();
			const failure = new Error("Nested listener failed");
			let nextListenerCalled = false;
			cell.events.on("delete", () => {
				throw failure;
			});
			cell.events.on("valueChanged", () => {
				assert.throws(
					() => cell.delete(),
					(error: unknown) => error === failure,
				);
			});
			cell.events.on("valueChanged", () => {
				nextListenerCalled = true;
				assertFaulted(cell, failure);
			});
			assert.throws(
				() => cell.set(1),
				(error: unknown) => error instanceof Error && error.cause === failure,
			);
			assert(nextListenerCalled);
			assertFaulted(cell, failure);
		});
	});
});
