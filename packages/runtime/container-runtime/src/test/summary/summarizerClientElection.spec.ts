/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import type { ISequencedClient } from "@fluidframework/driver-definitions";
import { SummarizerClientElection, summarizerClientType } from "../../summary/index.js";
import { TestQuorumClients } from "./testQuorumClients.js";

describe("Summarizer Client Election", () => {
	function setup(initialClients: [string, number, boolean, string?][] = []) {
		const quorum = new TestQuorumClients();
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
		const election = new SummarizerClientElection(quorum);
		let events = 0;
		election.events.on("electedSummarizerChanged", () => events++);
		return {
			election,
			quorum,
			add,
			get events() {
				return events;
			},
			remove(id: string) {
				sequenceNumber++;
				quorum.removeClient(id);
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

	it("reconstructs election from quorum and agrees through subsequent departures", () => {
		const test = setup([
			["a", 1, true],
			["b", 2, true],
			["s", 3, false, summarizerClientType],
		]);
		assert.equal(test.election.electedParentId, "a");
		assert.equal(test.election.hasSummarizer, true);
		const restored = new SummarizerClientElection(test.quorum);
		test.remove("a");
		assert.equal(restored.electedParentId, test.election.electedParentId);
		test.remove("s");
		assert.equal(restored.hasSummarizer, false);
		assert.equal(restored.hasSummarizer, test.election.hasSummarizer);
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
