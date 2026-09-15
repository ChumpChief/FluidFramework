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
				mergeTree.root,
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
				block,
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
