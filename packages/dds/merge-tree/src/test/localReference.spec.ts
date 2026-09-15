/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { LocalReferenceCollection, type LocalReferencePosition } from "../localReference.js";
import type { ISegmentInternal } from "../mergeTreeNodes.js";
import { type Trackable, UnorderedTrackingGroup } from "../mergeTreeTracking.js";
import { ReferenceType } from "../ops.js";
import { TextSegment } from "../textSegment.js";

import { validateRefCount } from "./testUtils.js";

interface TestSetup {
	collection: LocalReferenceCollection;
	/**
	 * All refs in collection order (offset ascending, and insertion order within an offset).
	 */
	refs: LocalReferencePosition[];
}

function assertNodeBackedReference(
	ref: LocalReferencePosition,
): asserts ref is LocalReferencePosition & { getListNode(): unknown } {
	assert("getListNode" in ref && typeof ref.getListNode === "function");
}

/**
 * Creates a collection over a segment of length `text.length` with `refsPerOffset`
 * references at every offset. Each reference is labeled via its `id` property so
 * walk order can be asserted.
 */
function setup(text: string, refsPerOffset: number): TestSetup {
	const segment = TextSegment.make(text) as ISegmentInternal;
	const collection = LocalReferenceCollection.setOrGet(segment);
	const refs: LocalReferencePosition[] = [];
	for (let offset = 0; offset < text.length; offset++) {
		for (let i = 0; i < refsPerOffset; i++) {
			refs.push(
				collection.createLocalRef(offset, ReferenceType.Simple, { id: `${offset}-${i}` }),
			);
		}
	}
	return { collection, refs };
}

function walk(
	collection: LocalReferenceCollection,
	start?: LocalReferencePosition,
	forward: boolean = true,
): string[] {
	const visited: string[] = [];
	collection.walkReferences(
		(lref) => {
			visited.push(lref.properties?.id as string);
		},
		start,
		forward,
	);
	return visited;
}

/**
 * Slides references into the `before` bucket at offset 0, or the `after` bucket at the last
 * offset, of `collection`. Tombstoned references arrive from a segment that was removed, so
 * they are created on a donor segment and re-linked by the collection.
 */
function addTombstones(
	collection: LocalReferenceCollection,
	position: "before" | "after",
	ids: string[],
): LocalReferencePosition[] {
	const donor = TextSegment.make("x") as ISegmentInternal;
	const donorCollection = LocalReferenceCollection.setOrGet(donor);
	const refs = ids.map((id) =>
		donorCollection.createLocalRef(0, ReferenceType.SlideOnRemove, { id }),
	);
	if (position === "before") {
		collection.addBeforeTombstones(refs);
	} else {
		collection.addAfterTombstones(refs);
	}
	return refs;
}

describe("LocalReferenceCollection", () => {
	describe("takeReferencesForAppend", () => {
		it("takes the buckets without rebinding reference positions", () => {
			const { collection, refs } = setup("abc", 1);
			const firstRef = refs[0];
			const segment = firstRef.getSegment();
			assertNodeBackedReference(firstRef);
			const firstNode = firstRef.getListNode();
			assert(firstNode !== undefined);

			const transfer = collection.takeReferencesForAppend();

			assert.equal(transfer.count, 3);
			assert.equal(transfer.buckets.length, 3);
			assert.equal(transfer.buckets[0]?.at?.first, firstNode);
			assert.equal(collection.size, 0);
			assert.deepEqual([...collection], []);
			for (let offset = 0; offset < refs.length; offset++) {
				assert.equal(refs[offset].getSegment(), segment);
				assert.equal(refs[offset].getOffset(), offset);
			}
			validateRefCount(collection);
		});
	});

	describe("append", () => {
		it("transfers all buckets without replacing references or list nodes", () => {
			const { collection: sourceRefs, refs } = setup("abc", 2);
			const source: ISegmentInternal | undefined = refs[0].getSegment();
			assert(source !== undefined);
			const before = addTombstones(sourceRefs, "before", ["b-0", "b-1"]);
			const after = addTombstones(sourceRefs, "after", ["a-0", "a-1"]);
			const movedRefs = [...sourceRefs];
			const originalState = new Map<
				LocalReferencePosition,
				{ node: unknown; offset: number }
			>();
			for (const ref of movedRefs) {
				assertNodeBackedReference(ref);
				const node = ref.getListNode();
				assert(node !== undefined);
				originalState.set(ref, { node, offset: ref.getOffset() });
				ref.callbacks = {
					beforeSlide: () => assert.fail("Appending must not invoke slide callbacks"),
					afterSlide: () => assert.fail("Appending must not invoke slide callbacks"),
				};
			}
			const target: ISegmentInternal = TextSegment.make("xy");
			const targetRefs = LocalReferenceCollection.setOrGet(target);
			const retained = targetRefs.createLocalRef(1, ReferenceType.Simple, { id: "retained" });
			const expectedOrder = ["retained", ...walk(sourceRefs)];

			target.append(source);

			assert.equal(target.localRefs, targetRefs);
			assert.equal(source.localRefs, sourceRefs);
			assert.equal(targetRefs.size, movedRefs.length + 1);
			assert.equal(sourceRefs.size, 0);
			assert.deepEqual([...sourceRefs], []);
			assert.deepEqual([...targetRefs], [retained, ...movedRefs]);
			assert.equal(retained.getOffset(), 1);
			assert(targetRefs.has(retained));
			assert.deepEqual(walk(targetRefs), expectedOrder);
			assert.deepEqual(walk(targetRefs, undefined, false), [...expectedOrder].reverse());
			for (const ref of movedRefs) {
				assertNodeBackedReference(ref);
				const original = originalState.get(ref);
				assert(original !== undefined);
				assert.equal(ref.getListNode(), original.node);
				assert.equal(ref.getOffset(), original.offset + 2);
				assert.equal(ref.getSegment(), target);
				assert(targetRefs.has(ref));
				assert(!sourceRefs.has(ref));
			}
			for (const ref of before) {
				assert(!targetRefs.isAfterTombstone(ref));
			}
			for (const ref of after) {
				assert(targetRefs.isAfterTombstone(ref));
			}

			const removed = movedRefs[0];
			assert.equal(targetRefs.removeLocalRef(removed), removed);
			assert.equal(targetRefs.size, movedRefs.length);
			assert.equal(sourceRefs.size, 0);
			assert.deepEqual([...sourceRefs], []);
			validateRefCount(targetRefs);
			validateRefCount(sourceRefs);
		});

		it("adopts transferred buckets before relinking tracking groups", () => {
			const source: ISegmentInternal = TextSegment.make("cd");
			const sourceRefs = LocalReferenceCollection.setOrGet(source);
			const trackedRef = sourceRefs.createLocalRef(0, ReferenceType.Simple, undefined);
			sourceRefs.createLocalRef(1, ReferenceType.Simple, undefined);
			const target: ISegmentInternal = TextSegment.make("ab");
			const targetRefs = LocalReferenceCollection.setOrGet(target);
			targetRefs.createLocalRef(0, ReferenceType.Simple, undefined);
			const events: string[] = [];
			let observe = false;
			class ObservingGroup extends UnorderedTrackingGroup {
				public override unlink(trackable: Trackable): boolean {
					if (observe) {
						assert.equal(trackable, trackedRef);
						assert.equal(sourceRefs.size, 0);
						assert.equal(targetRefs.size, 3);
						assert.equal(trackedRef.getSegment(), source);
						assert(!sourceRefs.has(trackedRef));
						assert([...targetRefs].includes(trackedRef));
						validateRefCount(sourceRefs);
						validateRefCount(targetRefs);
						events.push("unlink");
					}
					return super.unlink(trackable);
				}

				public override link(trackable: Trackable): void {
					if (observe) {
						assert.equal(trackable, trackedRef);
						assert.equal(sourceRefs.size, 0);
						assert.equal(targetRefs.size, 3);
						assert.equal(trackedRef.getSegment(), target);
						assert(!sourceRefs.has(trackedRef));
						assert([...targetRefs].includes(trackedRef));
						validateRefCount(sourceRefs);
						validateRefCount(targetRefs);
						events.push("link");
					}
					super.link(trackable);
				}
			}
			const group = new ObservingGroup();
			trackedRef.trackingCollection.link(group);
			observe = true;

			target.append(source);

			assert.deepEqual(events, ["unlink", "link"]);
			assert(group.has(trackedRef));
			assert(targetRefs.has(trackedRef));
			assert.equal(trackedRef.getOffset(), 2);
			validateRefCount(targetRefs);
			validateRefCount(sourceRefs);
		});

		it("retains all buckets when tracking fails after a reference has been rebound", () => {
			const source: ISegmentInternal = TextSegment.make("cd");
			const sourceRefs = LocalReferenceCollection.setOrGet(source);
			const firstRef = sourceRefs.createLocalRef(0, ReferenceType.Simple, undefined);
			const failingRef = sourceRefs.createLocalRef(1, ReferenceType.Simple, undefined);
			const target: ISegmentInternal = TextSegment.make("ab");
			const failure = new Error("Tracking failure");
			let throwOnUnlink = false;
			class ThrowingGroup extends UnorderedTrackingGroup {
				public override unlink(trackable: Trackable): boolean {
					if (throwOnUnlink) {
						throw failure;
					}
					return super.unlink(trackable);
				}
			}
			failingRef.trackingCollection.link(new ThrowingGroup());
			throwOnUnlink = true;

			assert.throws(
				() => target.append(source),
				(error) => error === failure,
			);
			assert.deepEqual([...sourceRefs], []);
			assert(target.localRefs !== undefined);
			assert.deepEqual([...target.localRefs], [firstRef, failingRef]);
			assert.equal(firstRef.getSegment(), target);
			assert.equal(firstRef.getOffset(), 2);
			assert(target.localRefs.has(firstRef));
			assert.equal(failingRef.getSegment(), source);
			assert.equal(failingRef.getOffset(), 1);
			assert(!target.localRefs.has(failingRef));
			assert(!sourceRefs.has(failingRef));
			validateRefCount(sourceRefs);
			validateRefCount(target.localRefs);
		});

		it("transfers large offset ranges without spreading the bucket array into a call", () => {
			const length = 200_000;
			const source: ISegmentInternal = TextSegment.make("x".repeat(length));
			const sourceRefs = LocalReferenceCollection.setOrGet(source);
			const ref = sourceRefs.createLocalRef(length - 1, ReferenceType.Simple, undefined);
			const target: ISegmentInternal = TextSegment.make("a");

			target.append(source);

			assert(target.localRefs !== undefined);
			assert(target.localRefs.has(ref));
			assert.equal(ref.getSegment(), target);
			assert.equal(ref.getOffset(), length);
			assert.equal(target.cachedLength, length + 1);
			assert.equal(target.localRefs.size, 1);
			assert.equal(sourceRefs.size, 0);
			validateRefCount(target.localRefs);
			validateRefCount(sourceRefs);
		});

		it("rejects self-transfer before changing the collection", () => {
			const segment: ISegmentInternal = TextSegment.make("a");
			const collection = LocalReferenceCollection.setOrGet(segment);
			const ref = collection.createLocalRef(0, ReferenceType.Simple, undefined);

			assert.throws(() => segment.append(segment), /itself/);
			assert.equal(collection.size, 1);
			assert(collection.has(ref));
			assert.equal(ref.getOffset(), 0);
			assert.equal(segment.cachedLength, 1);
		});

		for (const incomingHasCollection of [false, true]) {
			it(`does not allocate a receiver collection for unreferenced content (incomingHasCollection=${incomingHasCollection})`, () => {
				const segment: ISegmentInternal = TextSegment.make("ab");
				const other: ISegmentInternal = TextSegment.make("cd");
				if (incomingHasCollection) {
					LocalReferenceCollection.setOrGet(other);
				}

				segment.append(other);

				assert.equal(segment.cachedLength, 4);
				assert.equal(segment.localRefs, undefined);
				assert.equal(other.localRefs?.empty, incomingHasCollection ? true : undefined);
			});

			it(`keeps offsets aligned across unreferenced appends (incomingHasCollection=${incomingHasCollection})`, () => {
				const segment: ISegmentInternal = TextSegment.make("ab");
				const collection = LocalReferenceCollection.setOrGet(segment);
				const gap: ISegmentInternal = TextSegment.make("cd");
				if (incomingHasCollection) {
					LocalReferenceCollection.setOrGet(gap);
				}
				segment.append(gap);
				assert.equal(segment.localRefs, collection);
				assert(collection.empty);

				const other: ISegmentInternal = TextSegment.make("ef");
				const otherRefs = LocalReferenceCollection.setOrGet(other);
				const incomingRef = otherRefs.createLocalRef(1, ReferenceType.Simple, {
					id: "incoming",
				});
				segment.append(other);
				const gapRef = collection.createLocalRef(3, ReferenceType.Simple, { id: "gap" });

				assert.equal(segment.cachedLength, 6);
				assert.equal(incomingRef.getSegment(), segment);
				assert.equal(incomingRef.getOffset(), 5);
				assert.equal(gapRef.getOffset(), 3);
				assert(collection.has(incomingRef));
				assert(otherRefs.empty);
				assert.deepEqual(walk(collection), ["gap", "incoming"]);
				validateRefCount(collection);
				validateRefCount(otherRefs);
			});
		}

		it("creates a receiver collection when the incoming segment has references", () => {
			const segment: ISegmentInternal = TextSegment.make("ab");
			const other: ISegmentInternal = TextSegment.make("cd");
			const otherRefs = LocalReferenceCollection.setOrGet(other);
			const ref = otherRefs.createLocalRef(1, ReferenceType.Simple, undefined);

			segment.append(other);

			assert(segment.localRefs !== undefined);
			assert(segment.localRefs.has(ref));
			assert.equal(ref.getSegment(), segment);
			assert.equal(ref.getOffset(), 3);
			assert(otherRefs.empty);
			validateRefCount(segment.localRefs);
			validateRefCount(otherRefs);
		});

		it("rejects a transfer after the receiver length has already changed", () => {
			const segment: ISegmentInternal = TextSegment.make("ab");
			const collection = LocalReferenceCollection.setOrGet(segment);
			const other: ISegmentInternal = TextSegment.make("c");
			const otherRefs = LocalReferenceCollection.setOrGet(other);
			const ref = otherRefs.createLocalRef(0, ReferenceType.Simple, undefined);
			segment.cachedLength += other.cachedLength;

			assert.throws(() => collection.append(other), /0x2be/);
			assert(otherRefs.has(ref));
			assert.equal(ref.getSegment(), other);
		});
	});

	describe("split", () => {
		it("initializes split reference counts for before, at, and after buckets", () => {
			const { collection: suffixCollection, refs } = setup("abc", 2);
			const suffix = refs[0].getSegment();
			assert(suffix !== undefined);
			const before = addTombstones(suffixCollection, "before", ["b-0", "b-1"]);
			const after = addTombstones(suffixCollection, "after", ["a-0", "a-1"]);
			const segment: ISegmentInternal = TextSegment.make("x");
			const collection = LocalReferenceCollection.setOrGet(segment);
			const retainedRef = collection.createLocalRef(0, ReferenceType.Simple, {
				id: "retained",
			});
			segment.append(suffix);

			const splitSegment: ISegmentInternal | undefined = segment.splitAt(1);
			assert(splitSegment !== undefined);
			collection.split(1, splitSegment);
			const splitCollection = splitSegment.localRefs;
			assert(splitCollection !== undefined);
			const movedRefs = [...before, ...refs, ...after];
			assert.deepEqual([...collection], [retainedRef]);
			assert.deepEqual([...splitCollection], movedRefs);
			for (const ref of movedRefs) {
				assert.equal(ref.getSegment(), splitSegment);
				assert(splitCollection.has(ref));
				assert(!collection.has(ref));
			}
			for (const ref of after) {
				assert(splitCollection.isAfterTombstone(ref));
			}
			assert.deepEqual(walk(splitCollection), [
				"b-0",
				"b-1",
				"0-0",
				"0-1",
				"1-0",
				"1-1",
				"2-0",
				"2-1",
				"a-0",
				"a-1",
			]);
			validateRefCount(collection);
			validateRefCount(splitCollection);

			for (const ref of movedRefs) {
				assert.equal(splitCollection.removeLocalRef(ref), ref);
			}
			assert(splitCollection.empty);
			assert(!collection.empty);
			validateRefCount(collection);
			validateRefCount(splitCollection);
		});

		it("initializes an empty split collection when all references remain in the source", () => {
			const segment: ISegmentInternal = TextSegment.make("abc");
			const collection = LocalReferenceCollection.setOrGet(segment);
			const retainedRef = collection.createLocalRef(0, ReferenceType.Simple, undefined);
			const splitSegment: ISegmentInternal | undefined = segment.splitAt(1);
			assert(splitSegment !== undefined);
			collection.split(1, splitSegment);
			assert(splitSegment.localRefs !== undefined);
			assert(splitSegment.localRefs.empty);
			assert.deepEqual([...collection], [retainedRef]);
			validateRefCount(collection);
			validateRefCount(splitSegment.localRefs);
		});
	});

	describe("[Symbol.iterator]", () => {
		it("captures existing bucket lists when creating a collection iterator", () => {
			const segment: ISegmentInternal = TextSegment.make("ab");
			const collection = LocalReferenceCollection.setOrGet(segment);
			const first = collection.createLocalRef(0, ReferenceType.Simple, undefined);
			const iterator = collection[Symbol.iterator]();
			collection.createLocalRef(1, ReferenceType.Simple, undefined);

			assert.deepEqual([...iterator], [first]);
		});
	});

	describe("walkReferences", () => {
		it("walks all references when no start is provided", () => {
			const { collection } = setup("abc", 2);
			assert.deepEqual(walk(collection), ["0-0", "0-1", "1-0", "1-1", "2-0", "2-1"]);
		});

		it("walks all references backward when no start is provided", () => {
			const { collection } = setup("abc", 2);
			assert.deepEqual(walk(collection, undefined, false), [
				"2-1",
				"2-0",
				"1-1",
				"1-0",
				"0-1",
				"0-0",
			]);
		});

		it("includes the start reference when walking forward", () => {
			const { collection, refs } = setup("abc", 2);
			// refs[2] is the first reference at offset 1
			assert.deepEqual(walk(collection, refs[2]), ["1-0", "1-1", "2-0", "2-1"]);
		});

		it("includes the start reference when walking backward", () => {
			const { collection, refs } = setup("abc", 2);
			assert.deepEqual(walk(collection, refs[2], false), ["1-0", "0-1", "0-0"]);
		});

		it("resumes mid-list when start is not the first reference at its offset", () => {
			const { collection, refs } = setup("abc", 3);
			// refs[4] is the second reference at offset 1
			assert.deepEqual(walk(collection, refs[4]), ["1-1", "1-2", "2-0", "2-1", "2-2"]);
			assert.deepEqual(walk(collection, refs[4], false), ["1-1", "1-0", "0-2", "0-1", "0-0"]);
		});

		it("includes the start reference at the first offset", () => {
			const { collection, refs } = setup("abc", 1);
			assert.deepEqual(walk(collection, refs[0]), ["0-0", "1-0", "2-0"]);
			assert.deepEqual(walk(collection, refs[0], false), ["0-0"]);
		});

		it("includes the start reference at the last offset", () => {
			const { collection, refs } = setup("abc", 1);
			assert.deepEqual(walk(collection, refs[2]), ["2-0"]);
			assert.deepEqual(walk(collection, refs[2], false), ["2-0", "1-0", "0-0"]);
		});

		it("stops early when the visitor returns false", () => {
			const { collection, refs } = setup("abc", 2);
			const visited: string[] = [];
			const completed = collection.walkReferences((lref) => {
				visited.push(lref.properties?.id as string);
				return lref.properties?.id !== "1-1";
			}, refs[2]);
			assert.equal(completed, false);
			assert.deepEqual(visited, ["1-0", "1-1"]);
		});

		describe("when an offset holds multiple buckets", () => {
			/**
			 * Builds a collection over "abc" with an `at` reference at every offset, a `before`
			 * bucket coexisting with `at` at offset 0, and an `after` bucket coexisting with `at`
			 * at offset 2.
			 */
			function setupMultiBucket(): {
				collection: LocalReferenceCollection;
				at: LocalReferencePosition[];
				before: LocalReferencePosition[];
				after: LocalReferencePosition[];
			} {
				const { collection, refs: at } = setup("abc", 1);
				const before = addTombstones(collection, "before", ["b-0", "b-1"]);
				const after = addTombstones(collection, "after", ["a-0", "a-1"]);
				return { collection, at, before, after };
			}

			it("walks buckets in before/at/after order", () => {
				const { collection } = setupMultiBucket();
				assert.deepEqual(walk(collection), ["b-0", "b-1", "0-0", "1-0", "2-0", "a-0", "a-1"]);
				assert.deepEqual(walk(collection, undefined, false), [
					"a-1",
					"a-0",
					"2-0",
					"1-0",
					"0-0",
					"b-1",
					"b-0",
				]);
			});

			it("skips sibling buckets preceding the bucket holding start", () => {
				const { collection, at } = setupMultiBucket();
				// Starting at the `at` bucket must discard the `before` bucket at the same offset,
				// without discarding the `at` bucket itself.
				assert.deepEqual(walk(collection, at[0]), ["0-0", "1-0", "2-0", "a-0", "a-1"]);
				// Starting at the `at` bucket of the last offset must discard nothing it needs,
				// and still reach the trailing `after` bucket.
				assert.deepEqual(walk(collection, at[2]), ["2-0", "a-0", "a-1"]);
			});

			it("skips sibling buckets following the bucket holding start when walking backward", () => {
				const { collection, at } = setupMultiBucket();
				// Walking backward from the `at` bucket must discard the trailing `after` bucket
				// at the same offset, then continue into the `before` bucket.
				assert.deepEqual(walk(collection, at[2], false), ["2-0", "1-0", "0-0", "b-1", "b-0"]);
				assert.deepEqual(walk(collection, at[0], false), ["0-0", "b-1", "b-0"]);
			});

			it("starts within the before bucket", () => {
				const { collection, before } = setupMultiBucket();
				assert.deepEqual(walk(collection, before[1]), [
					"b-1",
					"0-0",
					"1-0",
					"2-0",
					"a-0",
					"a-1",
				]);
				assert.deepEqual(walk(collection, before[1], false), ["b-1", "b-0"]);
			});

			it("starts within the after bucket", () => {
				const { collection, after } = setupMultiBucket();
				assert.deepEqual(walk(collection, after[0]), ["a-0", "a-1"]);
				assert.deepEqual(walk(collection, after[0], false), [
					"a-0",
					"2-0",
					"1-0",
					"0-0",
					"b-1",
					"b-0",
				]);
			});
		});
	});
});
