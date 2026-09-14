/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { DoublyLinkedList } from "@fluidframework/core-utils/internal";

import { UnassignedSequenceNumber } from "../constants.js";
import type { ISegmentPrivate } from "../mergeTreeNodes.js";
import { matchProperties } from "../properties.js";
import { PropertiesManager, type PropsOrAdjust } from "../segmentPropertiesManager.js";
import { SnapshotV1 } from "../snapshotV1.js";

import { TestClient } from "./testClient.js";

describe("PropertiesManager", () => {
	describe("constructor", () => {
		it("copies initial change histories without sharing the input map or lists", () => {
			const local = new DoublyLinkedList([
				{ seq: UnassignedSequenceNumber, adjust: { delta: 3 } },
			]);
			const remote = new DoublyLinkedList([{ seq: 1, adjust: { delta: 2 } }]);
			const changes = new Map([["key", { msnConsensus: 1, local, remote }]]);
			const manager = new PropertiesManager(changes);

			changes.clear();
			local.shift();
			remote.shift();

			assert(manager.hasPendingProperties({ key: 6 }));
			assert.deepEqual(manager.getAtSeq({ key: 6 }, 0), { key: 1 });
			assert.deepEqual(manager.getAtSeq({ key: 6 }, 1), { key: 3 });
			manager.ack(2, 1, { adjust: { key: { delta: 3 } } });
			assert(!manager.hasPendingProperties({ key: 6 }));
			assert.deepEqual(manager.getAtSeq({ key: 6 }, 2), { key: 6 });
		});
	});

	describe("handleProperties", () => {
		it("should handle properties without collaboration", () => {
			const propertiesManager = new PropertiesManager();
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = {
				properties: { key: "value" },
			};
			const op: PropsOrAdjust = { props: { key: "newValue" } };
			const deltas = propertiesManager.handleProperties(op, seg, 1, 0, false);
			assert.deepEqual(deltas, { key: "value" });
			assert.deepEqual(seg.properties, { key: "newValue" });
		});

		it("should handle properties with collaboration", () => {
			const propertiesManager = new PropertiesManager();
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = {
				properties: { key: "value" },
			};
			const op: PropsOrAdjust = { props: { key: "newValue" } };
			const deltas = propertiesManager.handleProperties(
				op,
				seg,
				UnassignedSequenceNumber,
				0,
				true,
			);
			assert.deepEqual(deltas, { key: "value" });
			assert.deepEqual(seg.properties, { key: "newValue" });
		});

		it("should handle properties with rollback", () => {
			const propertiesManager = new PropertiesManager();
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = {
				properties: { key: "value" },
			};
			const op: PropsOrAdjust = { props: { key: "newValue" } };
			// Simulate pending state for rollback
			propertiesManager.handleProperties(op, seg, UnassignedSequenceNumber, 0, true);
			const deltas = propertiesManager.handleProperties(
				op,
				seg,
				UnassignedSequenceNumber,
				0,
				true,
				true,
			);
			assert.deepEqual(deltas, { key: "newValue" });
			assert.deepEqual(seg.properties, { key: "value" });
		});

		it("should handle properties with seq as a number and collaborating true", () => {
			const propertiesManager = new PropertiesManager();
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = {
				properties: { key: "value" },
			};
			const op: PropsOrAdjust = { props: { key: "newValue" } };
			const deltas = propertiesManager.handleProperties(op, seg, 2, 1, true);
			assert.deepEqual(deltas, { key: "value" });
			assert.deepEqual(seg.properties, { key: "newValue" });
		});

		it("should handle properties with seq as a number and collaborating false", () => {
			const propertiesManager = new PropertiesManager();
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = {
				properties: { key: "value" },
			};
			const op: PropsOrAdjust = { props: { key: "newValue" } };
			const deltas = propertiesManager.handleProperties(op, seg, 2, 1, false);
			assert.deepEqual(deltas, { key: "value" });
			assert.deepEqual(seg.properties, { key: "newValue" });
		});

		it("should handle properties with adjusts", () => {
			const propertiesManager = new PropertiesManager();
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = {
				properties: { key: 1 },
			};
			const op: PropsOrAdjust = { adjust: { key: { delta: 1 } } };
			const deltas = propertiesManager.handleProperties(op, seg, 2, 1, true);
			assert.deepEqual(deltas, { key: 1 });
			assert.deepEqual(seg.properties, { key: 2 });
		});

		it("should handle properties with props and adjusts interleaved", () => {
			const propertiesManager = new PropertiesManager();
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = {
				properties: { key: 1, otherKey: "value" },
			};
			const op1: PropsOrAdjust = { props: { otherKey: "newValue" } };
			const op2: PropsOrAdjust = { adjust: { key: { delta: 1 } } };
			propertiesManager.handleProperties(op1, seg, 2, 1, true);
			const deltas = propertiesManager.handleProperties(op2, seg, 3, 2, true);
			assert.deepEqual(deltas, { key: 1 });
			assert.deepEqual(seg.properties, { key: 2, otherKey: "newValue" });
		});
	});

	describe("rollbackProperties", () => {
		it("should rollback properties when collaborating is true", () => {
			const propertiesManager = new PropertiesManager();
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = {
				properties: { key: "value" },
			};
			const op: PropsOrAdjust = { props: { key: "newValue" } };
			const rollbackDeltas = propertiesManager.handleProperties(
				op,
				seg,
				UnassignedSequenceNumber,
				0,
				true,
			);
			const deltas = propertiesManager.rollbackProperties(
				{ props: rollbackDeltas },
				seg,
				true,
			);
			assert.deepEqual(deltas, { key: "newValue" });
			assert.deepEqual(seg.properties, { key: "value" });
		});

		it("should rollback properties when collaborating is false", () => {
			const propertiesManager = new PropertiesManager();
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = {
				properties: { key: "value" },
			};
			const op: PropsOrAdjust = { props: { key: "newValue" } };
			const rollbackDeltas = propertiesManager.handleProperties(
				op,
				seg,
				UnassignedSequenceNumber,
				0,
				false,
			);
			const deltas = propertiesManager.rollbackProperties(
				{ props: rollbackDeltas },
				seg,
				false,
			);
			assert.deepEqual(deltas, { key: "newValue" });
			assert.deepEqual(seg.properties, { key: "value" });
		});
	});

	describe("ack", () => {
		it("should acknowledge property changes", () => {
			const propertiesManager = new PropertiesManager();
			const op: PropsOrAdjust = { props: { key: "value" } };
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = { properties: {} };

			propertiesManager.handleProperties(op, seg, UnassignedSequenceNumber, 1, true);
			assert(propertiesManager.hasPendingProperties({ key: "value" }));
			propertiesManager.ack(1, 0, op);
		});
	});

	describe("clone", () => {
		it("copies manager state into a new manager", () => {
			const propertiesManager = new PropertiesManager();
			const op: PropsOrAdjust = { props: { key: "value" } };
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = { properties: {} };

			propertiesManager.handleProperties(op, seg, UnassignedSequenceNumber, 1, true);
			assert(propertiesManager.hasPendingProperties({ key: "value" }));
			const copy = propertiesManager.clone();
			assert.notEqual(copy, propertiesManager);
			assert(copy.hasPendingProperties({ key: "value" }));
		});

		it("clones an empty manager", () => {
			const manager = new PropertiesManager();
			const copy = manager.clone();
			assert.notEqual(copy, manager);
			assert(!copy.hasPendingProperties({ key: "value" }));
			assert.deepEqual(copy.getAtSeq({ key: "value" }, 0), { key: "value" });
		});

		it("copies local and remote histories without sharing their lists", () => {
			const source = new PropertiesManager();
			const seg = { properties: { key: 1 } };
			const remote: PropsOrAdjust = { adjust: { key: { delta: 2 } } };
			const local: PropsOrAdjust = { adjust: { key: { delta: 3 } } };
			source.handleProperties(remote, seg, 1, 0, true);
			source.handleProperties(local, seg, UnassignedSequenceNumber, 0, true);

			const copy = source.clone();

			copy.ack(2, 1, local);
			assert(source.hasPendingProperties({ key: 6 }));
			assert(!copy.hasPendingProperties({ key: 6 }));
			assert.deepEqual(source.getAtSeq(seg.properties, 0), { key: 1 });
			assert.deepEqual(source.getAtSeq(seg.properties, 1), { key: 3 });
			assert.deepEqual(copy.getAtSeq(seg.properties, 2), { key: 6 });

			source.rollbackProperties(local, seg, true);
			assert.deepEqual(seg.properties, { key: 3 });
			assert.deepEqual(copy.getAtSeq(seg.properties, 2), { key: 6 });
		});
	});

	describe("segment splitting", () => {
		it("copies properties and pending histories into the new segment", () => {
			const client = new TestClient();
			client.insertTextLocal(0, "abcd");
			client.startOrUpdateCollaboration("client");
			const annotation = client.annotateRangeLocal(0, 4, { key: "value" });
			client.insertTextLocal(2, "-");

			const left = client.getContainingSegment<ISegmentPrivate>(0)?.segment;
			const right = client.getContainingSegment<ISegmentPrivate>(3)?.segment;
			assert(left !== undefined && right !== undefined);
			assert(left.propertyManager !== undefined && right.propertyManager !== undefined);
			assert.notEqual(left.properties, right.properties);
			assert.notEqual(left.propertyManager, right.propertyManager);
			assert(matchProperties(left.properties, { key: "value" }));
			assert(matchProperties(right.properties, { key: "value" }));
			assert(left.propertyManager.hasPendingProperties({ key: "value" }));
			assert(right.propertyManager.hasPendingProperties({ key: "value" }));

			client.applyMsg(client.makeOpMessage(annotation, 1));
			assert(!left.propertyManager.hasPendingProperties({ key: "value" }));
			assert(!right.propertyManager.hasPendingProperties({ key: "value" }));
		});

		it("copies pending histories after snapshotting removed the property bag", () => {
			const client = new TestClient();
			client.insertTextLocal(0, "abcd", { key: "value" });
			client.startOrUpdateCollaboration("client");
			// eslint-disable-next-line unicorn/no-null
			const propertiesToRemove = { key: null };
			const annotation = client.annotateRangeLocal(0, 4, propertiesToRemove);
			const source = client.getContainingSegment<ISegmentPrivate>(0)?.segment;
			assert(source !== undefined);
			assert(source.propertyManager !== undefined);

			const snapshot = new SnapshotV1(client.mergeTree, client.logger, (id) =>
				client.getLongClientId(id),
			);
			snapshot.extractSync();
			assert.equal(source.properties, undefined);
			assert(source.propertyManager.hasPendingProperties(propertiesToRemove));

			client.insertTextLocal(2, "-");
			const split = client.getContainingSegment<ISegmentPrivate>(3)?.segment;
			assert(split !== undefined);
			assert.equal(split.properties, undefined);
			assert(split.propertyManager !== undefined);
			assert.notEqual(split.propertyManager, source.propertyManager);
			assert(split.propertyManager.hasPendingProperties(propertiesToRemove));

			client.applyMsg(client.makeOpMessage(annotation, 1));
			assert(!source.propertyManager.hasPendingProperties(propertiesToRemove));
			assert(!split.propertyManager.hasPendingProperties(propertiesToRemove));
		});

		for (const properties of [undefined, { key: "value" }]) {
			it(`does not allocate a manager when splitting ${properties === undefined ? "without" : "with"} properties but no history`, () => {
				const client = new TestClient();
				client.insertTextLocal(0, "abcd", properties);
				client.insertTextLocal(2, "-");

				const left = client.getContainingSegment<ISegmentPrivate>(0)?.segment;
				const right = client.getContainingSegment<ISegmentPrivate>(3)?.segment;
				assert(left !== undefined && right !== undefined);
				assert.equal(left.propertyManager, undefined);
				assert.equal(right.propertyManager, undefined);
				assert(matchProperties(left.properties, properties));
				assert(matchProperties(right.properties, properties));
				if (properties === undefined) {
					assert.equal(right.properties, undefined);
				} else {
					assert.notEqual(left.properties, right.properties);
				}
			});
		}
	});

	describe("getAtSeq", () => {
		it("should retrieve properties at a specific sequence number", () => {
			const propertiesManager = new PropertiesManager();
			const op: PropsOrAdjust = { adjust: { key: { delta: 5 } } };
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = { properties: {} };

			propertiesManager.handleProperties(op, seg, 1, 0, true);
			const properties = propertiesManager.getAtSeq(seg.properties, 0);
			assert(matchProperties(properties, {}));
		});
	});

	describe("hasPendingProperties", () => {
		it("should check for pending properties", () => {
			const propertiesManager = new PropertiesManager();
			const op: PropsOrAdjust = { props: { key: "value" } };
			const seg: Pick<ISegmentPrivate, "properties" | "propertyManager"> = { properties: {} };

			propertiesManager.handleProperties(op, seg, UnassignedSequenceNumber, 1, true);
			assert(propertiesManager.hasPendingProperties({ key: "value" }));
			assert(!propertiesManager.hasPendingProperties({ otherKey: "otherValue" }));
		});
	});
});
