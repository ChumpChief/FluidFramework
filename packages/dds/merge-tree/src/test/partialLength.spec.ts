/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { MergeTree } from "../mergeTree.js";
import { MergeBlock } from "../mergeTreeNodes.js";
import { MergeTreeDeltaType } from "../ops.js";
import { PartialSequenceLengths } from "../partialLengths.js";
import type { OperationStamp } from "../stamps.js";
import { TextSegment } from "../textSegment.js";

import {
	makeRemoteClient,
	useStrictPartialLengthChecks,
	validatePartialLengths,
} from "./testUtils.js";

describe("partial lengths", () => {
	let mergeTree: MergeTree;
	const localClientId = 17;
	const remoteClientId = 18;
	const refSeq = 0;

	const ackedLocalClientStamp = (seq: number): OperationStamp => ({
		seq,
		clientId: localClientId,
	});

	const remoteClient1 = makeRemoteClient({ clientId: 18 });

	useStrictPartialLengthChecks();

	beforeEach(() => {
		mergeTree = new MergeTree();
		mergeTree.insertSegments(
			0,
			[TextSegment.make("hello world!")],
			mergeTree.localPerspective,
			mergeTree.collabWindow.mintNextLocalOperationStamp(),
			undefined,
		);

		mergeTree.startCollaboration(localClientId, /* minSeq: */ 0, /* currentSeq: */ 0);
	});

	it("passes with no additional ops", () => {
		validatePartialLengths(localClientId, mergeTree, [{ seq: refSeq, len: 12 }]);
	});

	for (const computeLocalPartials of [false, true]) {
		it(`verifies empty partials (computeLocalPartials=${computeLocalPartials})`, () => {
			new PartialSequenceLengths(mergeTree.collabWindow, computeLocalPartials).verify();
		});

		it(`constructs leaf partials (computeLocalPartials=${computeLocalPartials})`, () => {
			mergeTree.insertSegments(
				0,
				[TextSegment.make("more ")],
				remoteClient1.perspectiveAt({ refSeq }),
				remoteClient1.stampAt({ seq: 1 }),
				undefined,
			);
			const localInsert = mergeTree.collabWindow.mintNextLocalOperationStamp();
			mergeTree.insertSegments(
				0,
				[TextSegment.make("local ")],
				mergeTree.localPerspective,
				localInsert,
				undefined,
			);

			const partials = new PartialSequenceLengths(
				mergeTree.collabWindow,
				computeLocalPartials,
				{ block: mergeTree.root },
			);

			assert.equal(partials.getPartialLength(0, remoteClientId + 1), 12);
			assert.equal(partials.getPartialLength(0, remoteClientId), 17);
			assert.equal(partials.getPartialLength(1, remoteClientId + 1), 17);
			if (computeLocalPartials) {
				assert.notEqual(localInsert.localSeq, undefined);
				assert.equal(partials.getPartialLength(0, localClientId, 0), 12);
				assert.equal(partials.getPartialLength(1, localClientId, 0), 17);
				assert.equal(partials.getPartialLength(1, localClientId, localInsert.localSeq), 23);
			}
		});

		it(`constructs only direct leaf partials (computeLocalPartials=${computeLocalPartials})`, () => {
			const block = new MergeBlock(2);
			block.children[0] = mergeTree.root;
			block.children[1] = mergeTree.root.children[0];
			mergeTree.collabWindow.minSeq = 5;
			mergeTree.collabWindow.currentSeq = 5;

			const partials = new PartialSequenceLengths(
				mergeTree.collabWindow,
				computeLocalPartials,
				{ block },
			);

			assert.equal(partials.minSeq, 5);
			assert.equal(partials.getPartialLength(5, remoteClientId), 12);
		});

		it(`verifies leaf initialization before aggregation (computeLocalPartials=${computeLocalPartials})`, () => {
			const block = new MergeBlock(1);
			block.children[0] = mergeTree.root;
			const verifiedLengths: number[] = [];
			const verifier = PartialSequenceLengths.options.verifier;
			PartialSequenceLengths.options.verifier = (partials) => {
				partials.verify();
				verifiedLengths.push(partials.getPartialLength(0, remoteClientId));
			};

			try {
				const combined = PartialSequenceLengths.combine(
					block,
					mergeTree.collabWindow,
					true,
					computeLocalPartials,
				);
				assert.equal(combined.getPartialLength(0, remoteClientId), 12);
				assert.deepEqual(verifiedLengths, [0, 12, 12, 12]);
			} finally {
				PartialSequenceLengths.options.verifier = verifier;
			}
		});
	}

	for (const zamboni of [false, true]) {
		it(`verifies after optional history compaction (zamboni=${zamboni})`, () => {
			mergeTree.insertSegments(
				0,
				[TextSegment.make("more ")],
				remoteClient1.perspectiveAt({ refSeq }),
				remoteClient1.stampAt({ seq: 1 }),
				undefined,
			);
			const partials = new PartialSequenceLengths(mergeTree.collabWindow, false, {
				block: mergeTree.root,
			});
			mergeTree.collabWindow.minSeq = 1;
			mergeTree.collabWindow.currentSeq = 1;

			const previousZamboni = PartialSequenceLengths.options.zamboni;
			const previousVerifier = PartialSequenceLengths.options.verifier;
			let verifierCalls = 0;
			PartialSequenceLengths.options.zamboni = zamboni;
			PartialSequenceLengths.options.verifier = (verified) => {
				verifierCalls++;
				assert.equal(verified, partials);
				assert.equal(verified.minSeq, zamboni ? 1 : 0);
				assert.deepEqual(verified.getIncrementalContribution(1), {
					segmentCount: 2,
					lengthDelta: zamboni ? 0 : 5,
					clientAdjustmentDeltas: zamboni ? [] : [5],
				});
				verified.verify();
			};

			try {
				partials.finishUpdate(mergeTree.collabWindow);
				assert.equal(verifierCalls, 1);
				assert.equal(partials.getPartialLength(1, remoteClientId), 17);
			} finally {
				PartialSequenceLengths.options.zamboni = previousZamboni;
				PartialSequenceLengths.options.verifier = previousVerifier;
			}
		});
	}

	describe("a single inserted element", () => {
		it("includes length of local insert for local view", () => {
			mergeTree.insertSegments(
				0,
				[TextSegment.make("more ")],
				mergeTree.localPerspective,
				ackedLocalClientStamp(refSeq + 1),
				{ op: { type: MergeTreeDeltaType.INSERT } },
			);

			validatePartialLengths(localClientId, mergeTree, [{ seq: 1, len: 17 }]);
		});
		it("includes length of local insert for remote view", () => {
			mergeTree.insertSegments(
				0,
				[TextSegment.make("more ")],
				mergeTree.localPerspective,
				ackedLocalClientStamp(refSeq + 1),
				{ op: { type: MergeTreeDeltaType.INSERT } },
			);

			validatePartialLengths(remoteClientId, mergeTree, [{ seq: 1, len: 17 }]);
		});
		it("includes length of remote insert for local view", () => {
			mergeTree.insertSegments(
				0,
				[TextSegment.make("more ")],
				remoteClient1.perspectiveAt({ refSeq }),
				remoteClient1.stampAt({ seq: refSeq + 1 }),
				{ op: { type: MergeTreeDeltaType.INSERT } },
			);

			validatePartialLengths(localClientId, mergeTree, [{ seq: 1, len: 17 }]);
		});
		it("includes length of remote insert for remote view", () => {
			mergeTree.insertSegments(
				0,
				[TextSegment.make("more ")],
				remoteClient1.perspectiveAt({ refSeq }),
				remoteClient1.stampAt({ seq: refSeq + 1 }),
				{ op: { type: MergeTreeDeltaType.INSERT } },
			);

			validatePartialLengths(remoteClientId, mergeTree, [{ seq: 1, len: 17 }]);
		});
	});

	describe("a single removed segment", () => {
		it("includes result of local delete for local view", () => {
			mergeTree.markRangeRemoved(
				0,
				12,
				mergeTree.localPerspective,
				ackedLocalClientStamp(refSeq + 1),
				undefined as never,
			);

			validatePartialLengths(localClientId, mergeTree, [{ seq: 1, len: 0 }]);
		});
		it("includes result of local delete for remote view", () => {
			mergeTree.markRangeRemoved(
				0,
				12,
				mergeTree.localPerspective,
				ackedLocalClientStamp(refSeq + 1),
				undefined as never,
			);

			validatePartialLengths(remoteClientId, mergeTree, [{ seq: 1, len: 0 }]);
		});
		it("includes result of remote delete for local view", () => {
			mergeTree.markRangeRemoved(
				0,
				12,
				remoteClient1.perspectiveAt({ refSeq }),
				ackedLocalClientStamp(refSeq + 1),
				undefined as never,
			);

			validatePartialLengths(localClientId, mergeTree, [{ seq: 1, len: 0 }]);
		});
		it("includes result of remote delete for remote view", () => {
			mergeTree.markRangeRemoved(
				0,
				12,
				remoteClient1.perspectiveAt({ refSeq }),
				ackedLocalClientStamp(refSeq + 1),
				undefined as never,
			);

			validatePartialLengths(remoteClientId, mergeTree, [{ seq: 1, len: 0 }]);
		});
	});

	describe("aggregation", () => {
		for (const computeLocalPartials of [false, true]) {
			it(`constructs an empty aggregate (computeLocalPartials=${computeLocalPartials})`, () => {
				const partials = new PartialSequenceLengths(
					mergeTree.collabWindow,
					computeLocalPartials,
					{ childPartials: [] },
				);
				partials.verify();
				assert.equal(partials.getPartialLength(0, remoteClientId), 0);
				if (computeLocalPartials) {
					assert.equal(partials.getPartialLength(0, localClientId, 0), 0);
				}
			});

			it(`aggregates child records without mutating them (computeLocalPartials=${computeLocalPartials})`, () => {
				const removingClient = makeRemoteClient({ clientId: 19 });
				mergeTree.insertSegments(
					0,
					[TextSegment.make("more ")],
					remoteClient1.perspectiveAt({ refSeq }),
					remoteClient1.stampAt({ seq: 1 }),
					undefined,
				);
				mergeTree.markRangeRemoved(
					0,
					5,
					mergeTree.localPerspective,
					mergeTree.collabWindow.mintNextLocalOperationStamp(),
					undefined as never,
				);
				mergeTree.markRangeRemoved(
					0,
					5,
					removingClient.perspectiveAt({ refSeq: 1 }),
					removingClient.stampAt({ seq: 2 }),
					undefined as never,
				);

				function checkLengths(partials: PartialSequenceLengths, multiplier: number): void {
					partials.verify();
					assert.equal(partials.getPartialLength(0, 20), 12 * multiplier);
					assert.equal(partials.getPartialLength(1, 20), 17 * multiplier);
					assert.equal(partials.getPartialLength(2, 20), 12 * multiplier);
					assert.equal(partials.getPartialLength(0, remoteClientId), 17 * multiplier);
					assert.equal(partials.getPartialLength(0, 19), 12 * multiplier);
					if (computeLocalPartials) {
						assert.equal(partials.getPartialLength(1, localClientId, 0), 17 * multiplier);
						assert.equal(partials.getPartialLength(1, localClientId, 1), 12 * multiplier);
						assert.equal(partials.getPartialLength(2, localClientId, 0), 12 * multiplier);
						assert.equal(partials.getPartialLength(2, localClientId, 1), 12 * multiplier);
					}
				}

				const childPartials: PartialSequenceLengths[] = [];
				for (let i = 0; i < 2; i++) {
					const child = new PartialSequenceLengths(
						mergeTree.collabWindow,
						computeLocalPartials,
						{ block: mergeTree.root },
					);
					checkLengths(child, 1);
					childPartials.push(child);
				}

				const combined = new PartialSequenceLengths(
					mergeTree.collabWindow,
					computeLocalPartials,
					{ childPartials },
				);
				checkLengths(combined, 2);
				for (const child of childPartials) {
					checkLengths(child, 1);
				}
			});
		}

		it("includes lengths from multiple permutations in single tree", () => {
			mergeTree.insertSegments(
				0,
				[TextSegment.make("1")],
				mergeTree.localPerspective,
				ackedLocalClientStamp(refSeq + 1),
				undefined,
			);
			mergeTree.insertSegments(
				0,
				[TextSegment.make("2")],
				remoteClient1.perspectiveAt({ refSeq: refSeq + 1 }),
				remoteClient1.stampAt({ seq: refSeq + 2 }),
				undefined,
			);
			mergeTree.insertSegments(
				0,
				[TextSegment.make("3")],
				mergeTree.localPerspective,
				ackedLocalClientStamp(refSeq + 3),
				undefined,
			);
			mergeTree.insertSegments(
				0,
				[TextSegment.make("4")],
				remoteClient1.perspectiveAt({ refSeq: refSeq + 3 }),
				remoteClient1.stampAt({ seq: refSeq + 4 }),
				undefined,
			);

			validatePartialLengths(localClientId, mergeTree, [{ seq: 4, len: 16 }]);
			validatePartialLengths(remoteClientId, mergeTree, [{ seq: 4, len: 16 }]);
		});

		it("is correct for different heights", () => {
			for (let i = 0; i < 100; i++) {
				mergeTree.insertSegments(
					0,
					[TextSegment.make("a")],
					mergeTree.localPerspective,
					ackedLocalClientStamp(i + 1),
					undefined,
				);

				validatePartialLengths(localClientId, mergeTree, [{ seq: i + 1, len: i + 13 }]);
				validatePartialLengths(remoteClientId, mergeTree, [{ seq: i + 1, len: i + 13 }]);
			}

			validatePartialLengths(localClientId, mergeTree, [{ seq: 100, len: 112 }]);
			validatePartialLengths(remoteClientId, mergeTree, [{ seq: 100, len: 112 }]);
		});
	});

	describe("incremental contributions", () => {
		it("marks the last invalidated sequence without changing calculated lengths", () => {
			const partials = new PartialSequenceLengths(mergeTree.collabWindow, false, {
				block: mergeTree.root,
			});
			const contribution = partials.getIncrementalContribution(1);
			assert(contribution !== undefined);

			partials.invalidateIncrementalPropagation(1);
			assert.equal(partials.getIncrementalContribution(1), undefined);
			assert.deepEqual(partials.getIncrementalContribution(2), contribution);
			assert.equal(partials.getPartialLength(1, remoteClientId), 12);

			partials.invalidateIncrementalPropagation(2);
			assert.deepEqual(partials.getIncrementalContribution(1), contribution);
			assert.equal(partials.getIncrementalContribution(2), undefined);
			assert.equal(partials.getPartialLength(2, remoteClientId), 12);
		});

		it("returns only deltas at the requested sequence, not cumulative or preceding lengths", () => {
			const empty = new PartialSequenceLengths(mergeTree.collabWindow, false);
			assert.deepEqual(empty.getIncrementalContribution(1), {
				segmentCount: 0,
				lengthDelta: 0,
				clientAdjustmentDeltas: [],
			});

			mergeTree.insertSegments(
				0,
				[TextSegment.make("more ")],
				remoteClient1.perspectiveAt({ refSeq }),
				remoteClient1.stampAt({ seq: 1 }),
				undefined,
			);
			mergeTree.insertSegments(
				0,
				[TextSegment.make("text")],
				remoteClient1.perspectiveAt({ refSeq: 1 }),
				remoteClient1.stampAt({ seq: 3 }),
				undefined,
			);
			const partials = new PartialSequenceLengths(mergeTree.collabWindow, false, {
				block: mergeTree.root,
			});

			for (const [seq, lengthDelta] of [
				[1, 5],
				[3, 4],
			]) {
				assert.deepEqual(partials.getIncrementalContribution(seq), {
					segmentCount: 3,
					lengthDelta,
					clientAdjustmentDeltas: [lengthDelta],
				});
			}
			for (const seq of [0, 2, 4]) {
				assert.deepEqual(partials.getIncrementalContribution(seq), {
					segmentCount: 3,
					lengthDelta: 0,
					clientAdjustmentDeltas: [],
				});
			}
		});

		it("preserves separate deltas from sparse client histories", () => {
			for (const clientId of [19, 20]) {
				const remoteClient = makeRemoteClient({ clientId });
				mergeTree.markRangeRemoved(
					0,
					5,
					remoteClient.perspectiveAt({ refSeq }),
					remoteClient.stampAt({ seq: clientId - 18 }),
					undefined as never,
				);
			}
			const partials = new PartialSequenceLengths(mergeTree.collabWindow, false, {
				block: mergeTree.root,
			});
			assert.deepEqual(partials.getIncrementalContribution(1), {
				segmentCount: 2,
				lengthDelta: -5,
				clientAdjustmentDeltas: [-5, -5],
			});
		});

		it("includes matching adjustment records whose deltas cancel to zero", () => {
			const stamp = remoteClient1.stampAt({ seq: 1 });
			const perspective = remoteClient1.perspectiveAt({ refSeq });
			mergeTree.insertSegments(0, [TextSegment.make("more ")], perspective, stamp, undefined);
			mergeTree.markRangeRemoved(0, 5, perspective, stamp, undefined as never);
			const partials = new PartialSequenceLengths(mergeTree.collabWindow, false, {
				block: mergeTree.root,
			});
			assert.deepEqual(partials.getIncrementalContribution(1), {
				segmentCount: 2,
				lengthDelta: 0,
				clientAdjustmentDeltas: [0],
			});
		});

		it("returns snapshots that remain unchanged after repeated updates at the same sequence", () => {
			const stamp = remoteClient1.stampAt({ seq: 1 });
			const perspective = remoteClient1.perspectiveAt({ refSeq });
			mergeTree.insertSegments(0, [TextSegment.make("a")], perspective, stamp, undefined);
			const partials = new PartialSequenceLengths(mergeTree.collabWindow, false, {
				block: mergeTree.root,
			});
			const contribution = partials.getIncrementalContribution(1);
			mergeTree.insertSegments(0, [TextSegment.make("bc")], perspective, stamp, undefined);
			for (let i = 0; i < 2; i++) {
				partials.update(mergeTree.root, 1, remoteClientId, mergeTree.collabWindow);
				assert.deepEqual(partials.getIncrementalContribution(1), {
					segmentCount: 3,
					lengthDelta: 3,
					clientAdjustmentDeltas: [3],
				});
			}
			assert.deepEqual(contribution, {
				segmentCount: 2,
				lengthDelta: 1,
				clientAdjustmentDeltas: [1],
			});
		});

		it("propagates a child's invalidation through full parent rebuilds", () => {
			mergeTree.insertSegments(
				0,
				[TextSegment.make("more ")],
				remoteClient1.perspectiveAt({ refSeq }),
				remoteClient1.stampAt({ seq: 1 }),
				undefined,
			);
			const child = mergeTree.root;
			const parent = new MergeBlock(1);
			parent.children[0] = child;
			const grandparent = new MergeBlock(1);
			grandparent.children[0] = parent;
			grandparent.partialLengths = PartialSequenceLengths.combine(
				grandparent,
				mergeTree.collabWindow,
				true,
			);

			const removingClientId = 19;
			const removingClient = makeRemoteClient({ clientId: removingClientId });
			mergeTree.markRangeRemoved(
				0,
				5,
				removingClient.perspectiveAt({ refSeq: 1 }),
				removingClient.stampAt({ seq: 2 }),
				undefined as never,
			);
			assert(child.partialLengths !== undefined);
			child.partialLengths.update(child, 2, removingClientId, mergeTree.collabWindow);
			assert.equal(child.partialLengths.getIncrementalContribution(2), undefined);

			for (const ancestor of [parent, grandparent]) {
				const previous = ancestor.partialLengths;
				assert(previous !== undefined);
				previous.update(ancestor, 2, removingClientId, mergeTree.collabWindow);
				assert.notEqual(ancestor.partialLengths, previous);
				assert(ancestor.partialLengths !== undefined);
				assert.equal(ancestor.partialLengths.getIncrementalContribution(2), undefined);
				assert.notEqual(ancestor.partialLengths.getIncrementalContribution(1), undefined);
				assert.equal(ancestor.partialLengths.getPartialLength(1, 20), 17);
				assert.equal(ancestor.partialLengths.getPartialLength(2, 20), 12);
				ancestor.partialLengths.verify();
			}
		});
	});

	describe("concurrent, overlapping deletes", () => {
		it("concurrent remote changes are visible to local", () => {
			const remoteClient2 = makeRemoteClient({ clientId: 19 });

			mergeTree.markRangeRemoved(
				0,
				10,
				remoteClient1.perspectiveAt({ refSeq }),
				remoteClient1.stampAt({ seq: refSeq + 1 }),
				undefined as never,
			);
			mergeTree.markRangeRemoved(
				0,
				10,
				remoteClient2.perspectiveAt({ refSeq }),
				remoteClient2.stampAt({ seq: refSeq + 2 }),
				undefined as never,
			);

			validatePartialLengths(localClientId, mergeTree, [{ seq: 1, len: 2 }]);
			validatePartialLengths(remoteClientId, mergeTree, [{ seq: 1, len: 2 }]);
			validatePartialLengths(remoteClientId + 1, mergeTree, [{ seq: 1, len: 2 }]);
		});
		it("concurrent local and remote changes are visible", () => {
			mergeTree.markRangeRemoved(
				0,
				10,
				mergeTree.localPerspective,
				ackedLocalClientStamp(refSeq + 1),
				undefined as never,
			);
			mergeTree.markRangeRemoved(
				0,
				10,
				remoteClient1.perspectiveAt({ refSeq }),
				remoteClient1.stampAt({ seq: refSeq + 2 }),
				undefined as never,
			);

			validatePartialLengths(localClientId, mergeTree, [{ seq: 1, len: 2 }]);
			validatePartialLengths(remoteClientId, mergeTree, [{ seq: 1, len: 2 }]);
		});
		it("concurrent remote and unsequenced local changes are visible", () => {
			mergeTree.markRangeRemoved(
				0,
				10,
				mergeTree.localPerspective,
				mergeTree.collabWindow.mintNextLocalOperationStamp(),
				undefined as never,
			);
			mergeTree.markRangeRemoved(
				0,
				10,
				remoteClient1.perspectiveAt({ refSeq }),
				remoteClient1.stampAt({ seq: refSeq + 1 }),
				undefined as never,
			);

			validatePartialLengths(localClientId, mergeTree, [{ seq: 1, len: 2 }]);
			validatePartialLengths(remoteClientId, mergeTree, [{ seq: 1, len: 2 }]);
		});
	});
});
