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
import type { ISequencedClient } from "@fluidframework/driver-definitions";
import { MessageType } from "@fluidframework/driver-definitions/internal";
import { MockLogger } from "@fluidframework/telemetry-utils/internal";

import {
	type IConnectedEvents,
	type IConnectedState,
	type ISerializedElection,
	type ISummarizer,
	type ISummaryCollectionOpEvents,
	SummarizerElection,
	SummaryManager,
	summarizerClientType,
} from "../../summary/index.js";

import { TestQuorumClients } from "./testQuorumClients.js";

describe("Summarizer Election", () => {
	const maxOps = 1000;
	const testQuorum = new TestQuorumClients();
	let currentSequenceNumber: number = 0;
	const testDeltaManager = {
		get lastSequenceNumber() {
			return currentSequenceNumber;
		},
	};
	const mockLogger = new MockLogger();
	const summaryCollectionEmitter = new TypedEventEmitter<ISummaryCollectionOpEvents>();
	let election: SummarizerElection;

	function addClient(
		clientId: string,
		sequenceNumber: number,
		interactive = true,
		type?: string,
	) {
		if (sequenceNumber > currentSequenceNumber) {
			currentSequenceNumber = sequenceNumber;
		}
		const details: ISequencedClient["client"]["details"] = {
			type,
			capabilities: { interactive },
		};
		const c: Partial<ISequencedClient["client"]> = { details };
		const client: ISequencedClient = {
			client: c as ISequencedClient["client"],
			sequenceNumber,
		};
		testQuorum.addClient(clientId, client);
	}
	function removeClient(clientId: string, opCount = 1) {
		currentSequenceNumber += opCount;
		testQuorum.removeClient(clientId);
	}

	function createElection(
		initialClients: [id: string, seq: number, int: boolean][] = [],
		initialState?: ISerializedElection,
	) {
		for (const [id, seq, int] of initialClients) {
			addClient(id, seq, int);
		}
		election = new SummarizerElection(
			mockLogger.toTelemetryLogger(),
			testDeltaManager,
			testQuorum,
			summaryCollectionEmitter,
			maxOps,
			initialState ?? currentSequenceNumber,
		);
	}

	function defaultOp(opCount = 1) {
		currentSequenceNumber += opCount;
		summaryCollectionEmitter.emit("default", { sequenceNumber: currentSequenceNumber });
	}
	function summaryAck(opCount = 1) {
		currentSequenceNumber += opCount;
		summaryCollectionEmitter.emit(MessageType.SummaryAck, {
			sequenceNumber: currentSequenceNumber,
		});
	}

	function assertState(
		expectedId: string | undefined,
		expectedParentId: string | undefined,
		expectedSeq: number,
		message: string,
	) {
		const { electedClientId, electedParentId, electionSequenceNumber } = election.serialize();
		assert.strictEqual(
			electedClientId,
			election.electedClientId,
			`Inconsistent clientId; ${message}`,
		);
		assert.strictEqual(
			electedParentId,
			election.electedParentId,
			`Inconsistent parentId; ${message}`,
		);
		assert.strictEqual(electedClientId, expectedId, `Invalid clientId; ${message}`);
		assert.strictEqual(electedParentId, expectedParentId, `Invalid parentId; ${message}`);
		assert.strictEqual(electionSequenceNumber, expectedSeq, `Invalid seq #; ${message}`);
	}

	afterEach(() => {
		mockLogger.clear();
		testQuorum.reset();
		summaryCollectionEmitter.removeAllListeners();
		election.removeAllListeners();
		currentSequenceNumber = 0;
	});

	describe("Oldest eligible client election", () => {
		it("Should initialize with empty quorum", () => {
			createElection();
			assertState(undefined, undefined, 0, "no clients");
		});

		it("Should elect oldest eligible interactive client", () => {
			createElection([
				["s1", 1, false],
				["a", 2, true],
				["s2", 4, false],
				["b", 7, true],
			]);
			assertState("a", "a", 7, "oldest interactive");
		});

		it("Should not elect non-interactive clients", () => {
			createElection([
				["s1", 1, false],
				["s2", 4, false],
			]);
			assertState(undefined, undefined, 4, "no interactive clients");
		});

		it("Should elect when first interactive client joins empty quorum", () => {
			createElection();
			addClient("a", 10, true);
			assertState("a", "a", 10, "first interactive client elected");
		});

		it("Should not change election when younger interactive client joins", () => {
			createElection([["a", 2, true]]);
			addClient("b", 20, true);
			assertState("a", "a", 2, "older client stays elected");
		});
	});

	describe("Re-election when parent leaves", () => {
		it("Should reelect next oldest when elected parent leaves", () => {
			createElection([
				["a", 2, true],
				["b", 7, true],
			]);
			assertState("a", "a", 7, "a is elected");
			removeClient("a", 5);
			assertState("b", "b", 12, "b takes over");
		});

		it("Should become undefined when last interactive client leaves", () => {
			createElection([["a", 2, true]]);
			assertState("a", "a", 2, "a is elected");
			removeClient("a", 5);
			assertState(undefined, undefined, 7, "no one to elect");
		});

		it("Should not change election when non-elected client leaves", () => {
			createElection([
				["a", 2, true],
				["b", 7, true],
			]);
			removeClient("b", 5);
			assertState("a", "a", 7, "a stays elected");
		});
	});

	describe("Summarizer client in quorum", () => {
		it("Should return summarizer as electedClientId when summarizer joins", () => {
			createElection([["a", 2, true]]);
			assertState("a", "a", 2, "parent is elected");
			addClient("a-summarizer", 10, false, summarizerClientType);
			assertState("a-summarizer", "a", 2, "summarizer is elected client");
		});

		it("Should revert to parent when summarizer leaves", () => {
			createElection([["a", 2, true]]);
			addClient("a-summarizer", 10, false, summarizerClientType);
			assertState("a-summarizer", "a", 2, "summarizer is elected");
			removeClient("a-summarizer", 5);
			assertState("a", "a", 2, "parent is elected again");
		});

		it("Should handle graceful handoff: A elected, A' joins, A leaves, B becomes parent, A' leaves", () => {
			createElection([
				["a", 2, true],
				["b", 7, true],
			]);
			assertState("a", "a", 7, "A is elected parent");

			// A spawns summarizer A'
			addClient("a-summarizer", 20, false, summarizerClientType);
			assertState("a-summarizer", "a", 7, "A' is elected client");

			// A leaves
			removeClient("a", 5);
			assertState("a-summarizer", "b", 25, "B becomes parent, A' still elected client");

			// A' leaves
			removeClient("a-summarizer", 5);
			assertState("b", "b", 25, "B becomes elected client");
		});
	});

	describe("electedSummarizerChanged event", () => {
		it("Should emit when parent changes", () => {
			createElection([
				["a", 2, true],
				["b", 7, true],
			]);
			let eventCount = 0;
			election.on("electedSummarizerChanged", () => eventCount++);
			removeClient("a", 5);
			assert.strictEqual(eventCount, 1, "event should fire on parent change");
		});

		it("Should emit when summarizer joins", () => {
			createElection([["a", 2, true]]);
			let eventCount = 0;
			election.on("electedSummarizerChanged", () => eventCount++);
			addClient("a-summarizer", 10, false, summarizerClientType);
			assert.strictEqual(eventCount, 1, "event should fire on summarizer join");
		});

		it("Should emit when summarizer leaves", () => {
			createElection([["a", 2, true]]);
			addClient("a-summarizer", 10, false, summarizerClientType);
			let eventCount = 0;
			election.on("electedSummarizerChanged", () => eventCount++);
			removeClient("a-summarizer", 5);
			assert.strictEqual(eventCount, 1, "event should fire on summarizer leave");
		});

		it("Should not emit when non-elected non-summarizer client leaves", () => {
			createElection([
				["a", 2, true],
				["b", 7, true],
			]);
			addClient("a-summarizer", 10, false, summarizerClientType);
			let eventCount = 0;
			election.on("electedSummarizerChanged", () => eventCount++);
			removeClient("b", 5);
			assert.strictEqual(eventCount, 0, "no event for non-elected, non-summarizer removal");
		});
	});

	describe("Op-counting telemetry", () => {
		it("Should log when ops exceed threshold without summary ack", () => {
			createElection([["a", 2, true]]);
			defaultOp(maxOps);
			assert.strictEqual(
				mockLogger.events.filter(
					(e) => e.eventName === "SummarizerElection:ElectedClientNotSummarizing",
				).length,
				0,
				"should not log at max ops",
			);
			defaultOp();
			assert.strictEqual(
				mockLogger.events.filter(
					(e) => e.eventName === "SummarizerElection:ElectedClientNotSummarizing",
				).length,
				1,
				"should log after exceeding max ops",
			);
		});

		it("Should reset op counter on summary ack", () => {
			createElection([["a", 2, true]]);
			defaultOp(maxOps);
			summaryAck();
			defaultOp(maxOps);
			assert.strictEqual(
				mockLogger.events.filter(
					(e) => e.eventName === "SummarizerElection:ElectedClientNotSummarizing",
				).length,
				0,
				"should not log when ack resets counter",
			);
			defaultOp();
			assert.strictEqual(
				mockLogger.events.filter(
					(e) => e.eventName === "SummarizerElection:ElectedClientNotSummarizing",
				).length,
				1,
				"should log after exceeding max ops since ack",
			);
		});
	});

	describe("Serialization", () => {
		it("Should serialize and restore correctly", () => {
			createElection([
				["a", 2, true],
				["b", 7, true],
			]);
			const serialized = election.serialize();
			assert.strictEqual(serialized.electedClientId, "a");
			assert.strictEqual(serialized.electedParentId, "a");
		});

		it("Should restore from serialized state", () => {
			createElection(
				[
					["a", 2, true],
					["b", 7, true],
				],
				{ electedClientId: "b", electedParentId: "b", electionSequenceNumber: 100 },
			);
			assertState("b", "b", 100, "restored from serialized state");
		});

		it("Should fall back to oldest when serialized parent not found", () => {
			createElection(
				[
					["a", 2, true],
					["b", 7, true],
				],
				{ electedClientId: "x", electedParentId: "x", electionSequenceNumber: 100 },
			);
			assertState("a", "a", 100, "fell back to oldest");
		});

		it("Should use summary ack seq in serialization when available", () => {
			createElection([["a", 2, true]]);
			summaryAck(50);
			const serialized = election.serialize();
			assert.strictEqual(serialized.electionSequenceNumber, 52, "uses ack seq");
		});
	});

	describe("Recovery", () => {
		it("Should recover when electedClientId is undefined but eligible clients exist", () => {
			createElection([], {
				electedClientId: undefined,
				electedParentId: undefined,
				electionSequenceNumber: 100,
			});
			assertState(undefined, undefined, 100, "no elected client initially");
			addClient("a", 10, true);
			assertState("a", "a", 10, "auto-elect on add");
		});

		it("Should auto-elect on op when eligible clients exist but none elected", () => {
			currentSequenceNumber = 100;
			createElection(
				[
					["s1", 1, false],
					["a", 2, true],
				],
				{
					electedClientId: undefined,
					electedParentId: undefined,
					electionSequenceNumber: 50,
				},
			);
			assertState(undefined, undefined, 50, "initial state is undefined");
			defaultOp();
			assertState("a", "a", 101, "auto-elect on op");
		});
	});

	describe("Edge cases", () => {
		it("Should handle empty quorum throughout", () => {
			createElection();
			defaultOp(100);
			assertState(undefined, undefined, 0, "still undefined");
		});

		it("Should handle all clients leave", () => {
			createElection([
				["a", 2, true],
				["b", 7, true],
			]);
			removeClient("a", 5);
			removeClient("b", 5);
			assertState(undefined, undefined, 17, "no clients left");
		});

		it("Should handle summarizer outliving parent", () => {
			createElection([
				["a", 2, true],
				["b", 7, true],
			]);
			addClient("a-summarizer", 20, false, summarizerClientType);
			removeClient("a", 5);
			assertState("a-summarizer", "b", 25, "summarizer outlives parent");
			removeClient("b", 5);
			assertState("a-summarizer", undefined, 30, "no parent, summarizer still alive");
			removeClient("a-summarizer", 5);
			assertState(undefined, undefined, 30, "everything gone");
		});

		it("Should pick up summarizer already in quorum at construction time", () => {
			// Add clients including a summarizer before creating the election
			addClient("a", 2, true);
			addClient("a-summarizer", 10, false, summarizerClientType);
			election = new SummarizerElection(
				mockLogger.toTelemetryLogger(),
				testDeltaManager,
				testQuorum,
				summaryCollectionEmitter,
				maxOps,
				currentSequenceNumber,
			);
			assertState("a-summarizer", "a", 10, "summarizer detected at construction");
		});
	});

	describe("Initialization from serialized state", () => {
		it("Should fall back to oldest when serialized parent is in quorum but ineligible", () => {
			// "s1" is non-interactive and non-summarizer, so ineligible
			createElection(
				[
					["s1", 1, false],
					["a", 5, true],
				],
				{ electedClientId: "s1", electedParentId: "s1", electionSequenceNumber: 100 },
			);
			assertState("a", "a", 100, "fell back to oldest eligible");
		});

		it("Should use electedClientId as parent when electedParentId is undefined (backward compat)", () => {
			createElection(
				[
					["a", 2, true],
					["b", 7, true],
				],
				{ electedClientId: "b", electedParentId: undefined, electionSequenceNumber: 100 },
			);
			assertState("b", "b", 100, "electedClientId used as parent");
		});

		it("Should not use electedClientId as parent when it is a summarizer type", () => {
			addClient("a", 2, true);
			addClient("a-summarizer", 10, false, summarizerClientType);
			election = new SummarizerElection(
				mockLogger.toTelemetryLogger(),
				testDeltaManager,
				testQuorum,
				summaryCollectionEmitter,
				maxOps,
				{
					electedClientId: "a-summarizer",
					electedParentId: undefined,
					electionSequenceNumber: 100,
				},
			);
			// Should fall through to findOldestEligibleParent, not use the summarizer as parent
			assertState("a-summarizer", "a", 100, "summarizer not used as parent");
		});

		it("Should fall back to oldest when electedClientId is in quorum but ineligible", () => {
			// "s1" is in quorum, matches electedClientId, but is ineligible
			createElection(
				[
					["s1", 1, false],
					["a", 5, true],
				],
				{ electedClientId: "s1", electedParentId: "s1", electionSequenceNumber: 100 },
			);
			// electedParentId "s1" is in quorum but ineligible → falls through
			// electedClientId "s1" is defined and IS in quorum → no error logged
			// falls back to findOldestEligibleParent
			assertState("a", "a", 100, "fell back to oldest eligible");
			mockLogger.assertMatchNone([
				{ eventName: "SummarizerElection:InitialElectedClientNotFound" },
			]);
		});

		it("Should log error when electedClientId is not found in quorum", () => {
			createElection(
				[
					["a", 2, true],
					["b", 7, true],
				],
				{ electedClientId: "x", electedParentId: "x", electionSequenceNumber: 100 },
			);
			assertState("a", "a", 100, "fell back to oldest");
			mockLogger.matchEvents([
				{
					eventName: "SummarizerElection:InitialElectedClientNotFound",
					expectedClientId: "x",
				},
			]);
		});
	});

	describe("clientDetailsPermitElection", () => {
		function makeDetails(
			interactive: boolean,
			type?: string,
		): ISequencedClient["client"]["details"] {
			const details: ISequencedClient["client"]["details"] = {
				capabilities: { interactive },
			};
			if (type !== undefined) {
				details.type = type;
			}
			return details;
		}

		it("Should permit interactive clients", () => {
			assert.strictEqual(
				SummarizerElection.clientDetailsPermitElection(makeDetails(true)),
				true,
			);
		});

		it("Should permit summarizer-type clients", () => {
			assert.strictEqual(
				SummarizerElection.clientDetailsPermitElection(
					makeDetails(false, summarizerClientType),
				),
				true,
			);
		});

		it("Should reject non-interactive non-summarizer clients", () => {
			assert.strictEqual(
				SummarizerElection.clientDetailsPermitElection(makeDetails(false)),
				false,
			);
		});
	});

	describe("Client eligibility edge cases", () => {
		it("Should elect interactive client with no type set (standard case)", () => {
			// Client with interactive capability but no type field — the common case
			const details: ISequencedClient["client"]["details"] = {
				capabilities: { interactive: true },
			};
			const c: Partial<ISequencedClient["client"]> = { details };
			const client: ISequencedClient = {
				client: c as ISequencedClient["client"],
				sequenceNumber: 5,
			};
			testQuorum.addClient("a", client);
			currentSequenceNumber = 5;
			election = new SummarizerElection(
				mockLogger.toTelemetryLogger(),
				testDeltaManager,
				testQuorum,
				summaryCollectionEmitter,
				maxOps,
				currentSequenceNumber,
			);
			assertState("a", "a", 5, "interactive client with no type is eligible");
		});

		it("Should not elect ineligible client when no parent is elected", () => {
			createElection();
			// Add a non-interactive, non-summarizer client — it is ineligible
			addClient("bot", 10, false);
			assertState(undefined, undefined, 0, "ineligible client not elected");
		});
	});

	describe("Op telemetry deduplication", () => {
		it("Should not log duplicate telemetry within the same window", () => {
			createElection([["a", 2, true]]);
			// Exceed threshold to trigger first log
			defaultOp(maxOps + 1);
			const firstCount = mockLogger.events.filter(
				(e) => e.eventName === "SummarizerElection:ElectedClientNotSummarizing",
			).length;
			assert.strictEqual(firstCount, 1, "should log once after exceeding threshold");

			// Send more ops within the same maxOps window — should NOT log again
			defaultOp(maxOps - 1);
			const secondCount = mockLogger.events.filter(
				(e) => e.eventName === "SummarizerElection:ElectedClientNotSummarizing",
			).length;
			assert.strictEqual(secondCount, 1, "should not log again within same window");

			// Exceed the next window — should log again
			defaultOp(2);
			const thirdCount = mockLogger.events.filter(
				(e) => e.eventName === "SummarizerElection:ElectedClientNotSummarizing",
			).length;
			assert.strictEqual(thirdCount, 2, "should log again after next window");
		});
	});

	describe("Integration with SummaryManager", () => {
		let summaryManager: SummaryManager;
		let connectedState: TestConnectedState;
		let summarizer: TestSummarizer;
		const summaryCollection = {
			opsSinceLastAck: 0,
			addOpListener: () => {},
			removeOpListener: () => {},
		};

		class TestConnectedState
			extends TypedEventEmitter<IConnectedEvents>
			implements IConnectedState
		{
			public connected = false;
			public clientId: string | undefined;

			public connect() {
				this.connected = true;
				this.clientId = election.electedParentId;
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				this.emit("connected", this.clientId!);
			}

			public disconnect() {
				this.connected = false;
				this.emit("disconnected");
			}
		}

		class TestSummarizer extends TypedEventEmitter<ISummarizerEvents> implements ISummarizer {
			private notImplemented(): never {
				throw new Error("not implemented");
			}
			public onBehalfOf: string | undefined;
			public state: "notStarted" | "running" | "stopped" = "notStarted";
			public readonly stopDeferred = new Deferred<string | undefined>();
			public readonly runDeferred = new Deferred<void>();
			public clientId: string | undefined;

			public async setSummarizer() {
				this.notImplemented();
			}
			public get cancelled() {
				return this.state !== "running";
			}
			public close() {}
			public stop(reason?: string): void {
				this.stopDeferred.resolve(reason);
			}
			public async run(onBehalfOf: string): Promise<SummarizerStopReason> {
				this.onBehalfOf = onBehalfOf;
				this.state = "running";
				await Promise.all([this.stopDeferred.promise, this.runDeferred.promise]);
				this.state = "stopped";
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				removeClient(this.clientId!, 0);
				return "summarizerClientDisconnected";
			}

			public readonly summarizeOnDemand = () => this.notImplemented();
			public readonly enqueueSummarize = () => this.notImplemented();
			public get IFluidLoadable() {
				return this.notImplemented();
			}
			public get handle() {
				return this.notImplemented();
			}
		}

		const flushPromises = async () => new Promise((resolve) => process.nextTick(resolve));

		const requestSummarizer = async (): Promise<ISummarizer> => {
			summarizer = new TestSummarizer();
			const parentId = election.electedParentId;
			const clientId = `${parentId}-summarizer`;
			summarizer.clientId = clientId;
			addClient(clientId, currentSequenceNumber, false, summarizerClientType);
			return summarizer;
		};

		const throttler = {
			delayMs: 0,
			numAttempts: 0,
			getDelay() {
				return this.delayMs;
			},
			maxDelayMs: 0,
			delayWindowMs: 0,
			delayFn: () => 0,
		};

		function createElectionWithManager(
			initialClients: [id: string, seq: number, int: boolean][] = [],
			initialState?: ISerializedElection,
		) {
			createElection(initialClients, initialState);
			connectedState = new TestConnectedState();
			summaryManager = new SummaryManager(
				election,
				connectedState,
				summaryCollection,
				mockLogger,
				requestSummarizer,
				throttler,
				{
					initialDelayMs: 0,
					opsToBypassInitialDelay: 0,
				},
			);
			summaryManager.start();
			election.on("electedSummarizerChanged", () => {
				connectedState.clientId = election.electedParentId;
			});
		}

		afterEach(() => {
			summaryManager?.dispose();
		});

		it("Should spawn summarizer and handle graceful handoff", async () => {
			createElectionWithManager([
				["a", 2, true],
				["b", 7, true],
			]);
			assertState("a", "a", 7, "a elected");
			connectedState.connect();
			await flushPromises();
			assertState("a-summarizer", "a", 7, "a's summarizer elected on connect");

			// A leaves, B becomes parent, but A' still working
			removeClient("a", 5);
			connectedState.disconnect();
			assertState("a-summarizer", "b", 12, "summarizer still doing work");

			// A' finishes
			summarizer.runDeferred.resolve();
			await flushPromises();
			assertState("b", "b", 12, "b elected after summarizer leaves");

			// B connects and spawns its own summarizer
			connectedState.connect();
			await flushPromises();
			assertState("b-summarizer", "b", 12, "b's summarizer elected");
		});

		it("Should auto-elect on op when initial state has undefined client", async () => {
			currentSequenceNumber = 678;
			createElectionWithManager(
				[
					["s1", 1, false],
					["a", 2, true],
					["s2", 4, false],
					["b", 7, true],
				],
				{
					electedClientId: undefined,
					electedParentId: undefined,
					electionSequenceNumber: 432,
				},
			);
			assertState(undefined, undefined, 432, "no elected client at first");
			defaultOp();
			assertState("a", "a", 679, "auto-elect first eligible client");
			connectedState.connect();
			await flushPromises();
			assertState("a-summarizer", "a", 679, "a's summarizer elected on connect");
		});

		it("Should handle add/remove clients with initial state", async () => {
			createElectionWithManager([], {
				electedClientId: undefined,
				electedParentId: undefined,
				electionSequenceNumber: 12,
			});
			assertState(undefined, undefined, 12, "initially undefined");

			addClient("s1", 1, false);
			assertState(undefined, undefined, 12, "non-interactive doesn't trigger election");

			addClient("a", 17, true);
			assertState("a", "a", 17, "first interactive client elected");
			connectedState.connect();
			await flushPromises();
			assertState("a-summarizer", "a", 17, "a's summarizer elected");

			addClient("s2", 19, false);
			addClient("b", 41, true);
			assertState("a-summarizer", "a", 17, "younger clients have no effect");

			removeClient("a", 400);
			connectedState.disconnect();
			assertState("a-summarizer", "b", 441, "summarizer still doing work");
			summarizer.runDeferred.resolve();
			await flushPromises();
			assertState("b", "b", 441, "next oldest client elected after summarizer leaves");
		});
	});
});
