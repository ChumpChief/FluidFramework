/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type { ISequencedClient } from "@fluidframework/driver-definitions";
import { MessageType } from "@fluidframework/driver-definitions/internal";
import { MockLogger } from "@fluidframework/telemetry-utils/internal";
import {
	type ISummaryCollectionOpEvents,
	SummarizerClientElection,
	summarizerClientType,
} from "../../summary/index.js";
import { TestQuorumClients } from "./testQuorumClients.js";

describe("Summarizer Client Election", () => {
	function setup(
		initialClients: [string, number, boolean, string?][] = [],
		initialState: number | { electionSequenceNumber: number } = 0,
	) {
		const quorum = new TestQuorumClients();
		const summaries = new TypedEventEmitter<ISummaryCollectionOpEvents>();
		const logger = new MockLogger();
		let sequenceNumber = 0;
		function add(id: string, seq: number, interactive = true, type?: string) {
			sequenceNumber = Math.max(sequenceNumber, seq);
			const client: ISequencedClient = {
				sequenceNumber: seq,
				client: {
					details: { capabilities: { interactive }, type },
					mode: "write",
					permission: [],
					user: { id },
					scopes: [],
				},
			};
			quorum.addClient(id, client);
		}
		for (const client of initialClients) {
			add(...client);
		}
		const delta = {
			get lastSequenceNumber() {
				return sequenceNumber;
			},
		};
		const election = new SummarizerClientElection(
			logger,
			delta,
			quorum,
			summaries,
			1000,
			initialState,
		);
		let events = 0;
		election.on("electedSummarizerChanged", () => events++);
		return {
			election,
			quorum,
			summaries,
			logger,
			get progressWarnings() {
				return logger.events.filter(
					(event) =>
						event.eventName === "SummarizerClientElection:ElectedClientNotSummarizing",
				);
			},
			delta,
			add,
			get events() {
				return events;
			},
			remove(id: string) {
				sequenceNumber++;
				quorum.removeClient(id);
			},
			op(count = 1) {
				sequenceNumber += count;
				summaries.emit("default", { sequenceNumber });
			},
			ack() {
				sequenceNumber++;
				summaries.emit(MessageType.SummaryAck, { sequenceNumber });
			},
		};
	}

	it("derives the oldest interactive parent regardless of quorum insertion order", () => {
		const test = setup([
			["b", 5, true],
			["bot", 1, false],
			["a", 2, true],
		]);
		assert.equal(test.election.electedParentId, "a");
		assert.equal(test.election.hasSummarizer, false);
		test.add("c", 6);
		test.remove("b");
		assert.equal(test.events, 0);
		test.remove("a");
		assert.equal(test.election.electedParentId, "c");
		assert.equal(test.events, 1);
	});

	it("elects the first interactive client and clears the parent after its departure", () => {
		const test = setup();
		test.add("bot", 1, false);
		assert.equal(test.events, 0);
		test.add("a", 2);
		assert.equal(test.election.electedParentId, "a");
		test.remove("a");
		assert.equal(test.election.electedParentId, undefined);
		assert.equal(test.events, 2);
	});

	it("logs parent and occupancy transitions but ignores irrelevant membership changes", () => {
		const test = setup([
			["a", 1, true],
			["b", 2, true],
		]);
		test.add("s1", 3, false, summarizerClientType);
		test.add("s2", 4, false, summarizerClientType);
		test.add("c", 5);
		test.remove("c");
		test.remove("a");
		test.remove("s1");
		test.remove("s2");
		const transitions = test.logger.events.filter(
			(event) => event.eventName === "SummarizerClientElection:ElectionChanged",
		);
		assert.deepEqual(
			transitions.map((event) => ({
				previousElectedParentId: event.previousElectedParentId,
				electedParentId: event.electedParentId,
				previousHasSummarizer: event.previousHasSummarizer,
				hasSummarizer: event.hasSummarizer,
				sequenceNumber: event.sequenceNumber,
			})),
			[
				{
					previousElectedParentId: "a",
					electedParentId: "a",
					previousHasSummarizer: false,
					hasSummarizer: true,
					sequenceNumber: 3,
				},
				{
					previousElectedParentId: "a",
					electedParentId: "b",
					previousHasSummarizer: true,
					hasSummarizer: true,
					sequenceNumber: 7,
				},
				{
					previousElectedParentId: "b",
					electedParentId: "b",
					previousHasSummarizer: true,
					hasSummarizer: false,
					sequenceNumber: 9,
				},
			],
		);
	});

	it("retains occupancy until every summarizer leaves, in either departure order", () => {
		for (const first of ["s1", "s2"]) {
			const test = setup([["a", 1, true]]);
			test.add("s1", 2, false, summarizerClientType);
			test.add("s2", 3, false, summarizerClientType);
			assert.equal(test.election.hasSummarizer, true);
			assert.equal(test.events, 1);
			test.remove(first);
			assert.equal(test.election.hasSummarizer, true);
			assert.equal(test.events, 1);
			test.remove(first === "s1" ? "s2" : "s1");
			assert.equal(test.election.hasSummarizer, false);
			assert.equal(test.events, 2);
		}
	});

	it("elects a new parent while the previous parent's summarizer remains", () => {
		const test = setup([
			["a", 1, true],
			["b", 2, true],
		]);
		test.add("s", 3, false, summarizerClientType);
		test.remove("a");
		assert.equal(test.election.electedParentId, "b");
		assert.equal(test.election.hasSummarizer, true);
		test.remove("s");
		assert.equal(test.election.electedParentId, "b");
		assert.equal(test.election.hasSummarizer, false);
	});

	it("tracks summarizers without an interactive parent", () => {
		const test = setup([["s", 1, false, summarizerClientType]]);
		assert.equal(test.election.electedParentId, undefined);
		assert.equal(test.election.hasSummarizer, true);
		test.add("a", 2);
		assert.equal(test.election.electedParentId, "a");
		test.remove("a");
		assert.equal(test.election.hasSummarizer, true);
	});

	it("reconstructs election from quorum and writes compatibility identities", () => {
		const oldState = {
			electedClientId: "missing",
			electedParentId: "b",
			electionSequenceNumber: 50,
		};
		const test = setup(
			[
				["a", 1, true],
				["b", 2, true],
				["s", 3, false, summarizerClientType],
			],
			oldState,
		);
		assert.equal(test.election.electedParentId, "a");
		assert.equal(test.election.hasSummarizer, true);
		assert.deepEqual(test.election.serialize(), {
			electionSequenceNumber: 50,
			electedClientId: "s",
			electedParentId: "a",
		});
		const restored = new SummarizerClientElection(
			test.logger,
			test.delta,
			test.quorum,
			test.summaries,
			1000,
			test.election.serialize(),
		);
		test.remove("s");
		assert.equal(restored.hasSummarizer, false);
		assert.deepEqual(restored.serialize(), test.election.serialize());
	});

	it("logs stalled progress at most once per op window and resets the baseline on ack", () => {
		const test = setup([["a", 1, true]]);
		test.op(1000);
		assert.equal(test.progressWarnings.length, 1);
		test.op(10);
		assert.equal(test.progressWarnings.length, 1);
		test.ack();
		const baseline = test.election.serialize();
		test.op(1000);
		assert.equal(test.progressWarnings.length, 1);
		test.op();
		assert.equal(test.progressWarnings.length, 2);
		assert.deepEqual(test.election.serialize(), baseline);
		assert.equal(test.events, 0);
	});

	it("keeps the ack baseline across irrelevant membership changes", () => {
		const test = setup([
			["a", 1, true],
			["s1", 2, false, summarizerClientType],
		]);
		test.ack();
		const baseline = test.election.serialize().electionSequenceNumber;
		test.add("b", 4);
		test.add("s2", 5, false, summarizerClientType);
		test.remove("s1");
		assert.equal(test.election.serialize().electionSequenceNumber, baseline);
		assert.equal(test.events, 0);
	});

	it("reports a stalled child through repeated parent departures", () => {
		const test = setup([
			["a", 1, true],
			["b", 2, true],
			["c", 3, true],
			["s", 4, false, summarizerClientType],
		]);
		test.ack();
		const baseline = test.election.serialize().electionSequenceNumber;
		test.op(900);
		test.remove("a");
		test.op(900);
		test.remove("b");
		test.op(900);
		assert.equal(test.election.serialize().electionSequenceNumber, baseline);
		assert.equal(test.progressWarnings.length, 1);
		assert.equal(test.election.electedParentId, "c");
	});

	it("does not log progress warnings for an empty election", () => {
		const test = setup();
		test.op(5000);
		assert.equal(test.logger.events.length, 0);
	});

	it("permits interactive and summarizer client details", () => {
		assert.equal(
			SummarizerClientElection.clientDetailsPermitElection({
				capabilities: { interactive: true },
			}),
			true,
		);
		assert.equal(
			SummarizerClientElection.clientDetailsPermitElection({
				capabilities: { interactive: false },
				type: summarizerClientType,
			}),
			true,
		);
		assert.equal(
			SummarizerClientElection.clientDetailsPermitElection({
				capabilities: { interactive: false },
			}),
			false,
		);
	});
});
