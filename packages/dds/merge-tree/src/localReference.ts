/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	assert,
	DoublyLinkedList,
	type ListNode,
	walkList,
} from "@fluidframework/core-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";

import type { ISegmentInternal } from "./mergeTreeNodes.js";
import { type TrackingGroup, TrackingGroupCollection } from "./mergeTreeTracking.js";
import { ReferenceType } from "./ops.js";
import { type PropertySet, addProperties } from "./properties.js";
import { type ReferencePosition, refTypeIncludesFlag } from "./referencePositions.js";

/**
 * Dictates the preferential direction for a {@link ReferencePosition} to slide
 * in a merge-tree
 * @legacy @beta
 */
export const SlidingPreference = {
	/**
	 * Prefer sliding towards the start of the tree
	 */
	BACKWARD: 0,
	/**
	 * Prefer sliding towards the end of the tree
	 */
	FORWARD: 1,
} as const;

/**
 * Dictates the preferential direction for a {@link ReferencePosition} to slide
 * in a merge-tree
 * @legacy @beta
 */
export type SlidingPreference = (typeof SlidingPreference)[keyof typeof SlidingPreference];

function _validateReferenceType(refType: ReferenceType): void {
	let exclusiveCount = 0;
	if (refTypeIncludesFlag(refType, ReferenceType.Transient)) {
		++exclusiveCount;
	}
	if (refTypeIncludesFlag(refType, ReferenceType.SlideOnRemove)) {
		++exclusiveCount;
	}
	if (refTypeIncludesFlag(refType, ReferenceType.StayOnRemove)) {
		++exclusiveCount;
	}
	if (exclusiveCount > 1) {
		throw new UsageError(
			"Reference types can only be one of Transient, SlideOnRemove, and StayOnRemove",
		);
	}
}
/**
 * @sealed
 * @legacy @beta
 */
export interface LocalReferencePosition extends ReferencePosition {
	callbacks?: Partial<
		Record<"beforeSlide" | "afterSlide", (ref: LocalReferencePosition) => void>
	>;
	readonly trackingCollection: TrackingGroupCollection;
	/**
	 * Whether or not this reference position can slide onto one of the two
	 * special segments representing the position before or after the tree
	 */
	readonly canSlideToEndpoint?: boolean;

	/**
	 * @param newProps - Properties to add to this reference.
	 * @remarks Note that merge-tree does not broadcast changes to other clients. It is up to the consumer
	 * to ensure broadcast happens if that is desired.
	 */
	addProperties(newProps: PropertySet): void;
}

/**
 * @privateRemarks This should not be exported outside merge tree.
 * @internal
 */
class LocalReference implements LocalReferencePosition {
	public properties: PropertySet | undefined;

	private segment: ISegmentInternal | undefined;
	private offset: number = 0;
	private listNode: ListNode<LocalReferencePosition> | undefined;

	public callbacks?:
		| Partial<Record<"beforeSlide" | "afterSlide", (ref: LocalReferencePosition) => void>>
		| undefined;
	private _trackingCollection?: TrackingGroupCollection;
	public get trackingCollection(): TrackingGroupCollection {
		return (this._trackingCollection ??= new TrackingGroupCollection(this));
	}

	constructor(
		public refType = ReferenceType.Simple,
		properties?: PropertySet,
		public readonly slidingPreference: SlidingPreference = SlidingPreference.FORWARD,
		public readonly canSlideToEndpoint?: boolean,
	) {
		_validateReferenceType(refType);
		this.properties = properties;
	}

	public link(
		segment: ISegmentInternal | undefined,
		offset: number,
		listNode: ListNode<LocalReferencePosition> | undefined,
	): void {
		if (listNode !== this.listNode && this.listNode !== undefined) {
			this.segment?.localRefs?.removeLocalRef(this);
		}
		this.listNode = listNode;

		if (segment !== this.segment) {
			const groups: TrackingGroup[] = [];
			for (const tg of this.trackingCollection.trackingGroups) {
				tg.unlink(this);
				groups.push(tg);
			}

			this.segment = segment;

			for (const tg of groups) tg.link(this);
		}
		this.offset = offset;
	}

	public isLeaf(): this is ISegmentInternal {
		return false;
	}

	public addProperties(newProps: PropertySet): void {
		this.properties = addProperties(this.properties, newProps);
	}

	public getSegment(): ISegmentInternal | undefined {
		return this.segment;
	}

	public getOffset(): number {
		return this.offset;
	}

	public getListNode(): ListNode<LocalReferencePosition> | undefined {
		return this.listNode;
	}

	public getProperties(): PropertySet | undefined {
		return this.properties;
	}
}

/**
 * Creates a new detached local reference.
 * @internal
 */
export function createDetachedLocalReferencePosition(
	slidingPreference: SlidingPreference | undefined,
	refType?: ReferenceType,
): LocalReferencePosition {
	return new LocalReference(refType, undefined, slidingPreference);
}

// Transferred buckets must not expose the implementation-private LocalReference class.
interface IRefsAtOffset {
	before?: DoublyLinkedList<LocalReferencePosition>;
	at?: DoublyLinkedList<LocalReferencePosition>;
	after?: DoublyLinkedList<LocalReferencePosition>;
}

interface LocalReferenceTransfer {
	readonly count: number;
	readonly buckets: readonly (IRefsAtOffset | undefined)[];
}

function createLocalReferenceIterator(
	refsByOffset: readonly (IRefsAtOffset | undefined)[],
): IterableIterator<LocalReferencePosition> {
	const subiterators: IterableIterator<ListNode<LocalReferencePosition>>[] = [];
	for (const refs of refsByOffset) {
		if (refs) {
			if (refs.before) {
				subiterators.push(refs.before[Symbol.iterator]());
			}
			if (refs.at) {
				subiterators.push(refs.at[Symbol.iterator]());
			}
			if (refs.after) {
				subiterators.push(refs.after[Symbol.iterator]());
			}
		}
	}

	return {
		next(): IteratorResult<LocalReferencePosition> {
			while (subiterators.length > 0) {
				const next = subiterators[0].next();
				if (next.done === true) {
					subiterators.shift();
				} else {
					return { done: next.done, value: next.value.data };
				}
			}

			return { value: undefined, done: true };
		},
		[Symbol.iterator](): IterableIterator<LocalReferencePosition> {
			return this;
		},
	};
}

function assertLocalReferences(lref: unknown): asserts lref is LocalReference {
	assert(lref instanceof LocalReference, 0x2e0 /* "lref not a Local Reference" */);
}

/**
 * Determines if the given function is true for any position within the collection.
 */
export function anyLocalReferencePosition(
	collection: LocalReferenceCollection,
	func: (pos: LocalReferencePosition) => boolean,
): boolean {
	for (const pos of collection) {
		if (func(pos)) {
			return true;
		}
	}

	return false;
}

/**
 * Finds the local reference positions that satisfy the given predicate.
 */
export function* filterLocalReferencePositions(
	collection: LocalReferenceCollection,
	predicate: (pos: LocalReferencePosition) => boolean,
): Generator<LocalReferencePosition> {
	for (const pos of collection) {
		if (predicate(pos)) {
			yield pos;
		}
	}
}

/**
 * Injectable hook for validating that the refCount property matches the
 * expected value
 */
let validateRefCount: ((collection?: LocalReferenceCollection) => void) | undefined;

export function setValidateRefCount(
	cb?: (collection?: LocalReferenceCollection) => void,
): void {
	validateRefCount = cb;
}

/**
 * Represents a collection of {@link LocalReferencePosition}s associated with
 * one segment in a merge-tree.
 * Represents a collection of {@link LocalReferencePosition}s associated with one segment in a merge-tree.
 * @sealed
 *
 * @internal
 */
export class LocalReferenceCollection {
	public static append(seg1: ISegmentInternal, seg2: ISegmentInternal): void {
		if (seg1.localRefs === undefined && seg2.localRefs?.empty === false) {
			LocalReferenceCollection.setOrGet(seg1);
		}
		seg1.localRefs?.append(seg2);
		validateRefCount?.(seg1.localRefs);
		validateRefCount?.(seg2.localRefs);
	}

	public static setOrGet(segment: ISegmentInternal): LocalReferenceCollection {
		return (segment.localRefs ??= new LocalReferenceCollection(segment));
	}

	private refsByOffset: (IRefsAtOffset | undefined)[];
	private refCount: number = 0;

	private constructor(
		/**
		 * The segment this `LocalReferenceCollection` is associated with.
		 */
		private readonly segment: ISegmentInternal,
		initialRefsByOffset?: (IRefsAtOffset | undefined)[],
	) {
		this.refsByOffset = initialRefsByOffset ?? Array.from({ length: segment.cachedLength });
		if (initialRefsByOffset !== undefined) {
			for (const refs of initialRefsByOffset) {
				this.refCount +=
					(refs?.before?.length ?? 0) + (refs?.at?.length ?? 0) + (refs?.after?.length ?? 0);
			}
		}
	}

	/**
	 * Returns an iterator over this LocalReferenceCollection.
	 * @remarks This method should only be called by mergeTree.
	 */
	public [Symbol.iterator](): {
		next(): IteratorResult<LocalReferencePosition>;
		[Symbol.iterator](): IterableIterator<LocalReferencePosition>;
	} {
		return createLocalReferenceIterator(this.refsByOffset);
	}

	/**
	 * Determines if the collection has no references in it.
	 * @remarks This method should only be called by mergeTree.
	 */
	public get empty(): boolean {
		validateRefCount?.(this);
		return this.refCount === 0;
	}

	/**
	 * The number of references stored in this collection.
	 */
	public get size(): number {
		return this.refCount;
	}

	/**
	 * Creates a new local reference.
	 * @remarks This method should only be called by mergeTree.
	 */
	public createLocalRef(
		offset: number,
		refType: ReferenceType,
		properties: PropertySet | undefined,
		slidingPreference?: SlidingPreference,
		canSlideToEndpoint?: boolean,
	): LocalReferencePosition {
		const ref = new LocalReference(refType, properties, slidingPreference, canSlideToEndpoint);
		ref.link(this.segment, offset, undefined);
		if (!refTypeIncludesFlag(ref, ReferenceType.Transient)) {
			this.addLocalRef(ref, offset);
		}
		validateRefCount?.(this);
		return ref;
	}

	/**
	 * Adds a local reference to the collection.
	 * @remarks This method should only be called by mergeTree.
	 */
	public addLocalRef(lref: LocalReferencePosition, offset: number): void {
		assertLocalReferences(lref);
		assert(
			offset < this.segment.cachedLength,
			0x348 /* offset cannot be beyond segment length */,
		);
		if (refTypeIncludesFlag(lref, ReferenceType.Transient)) {
			lref.link(this.segment, offset, undefined);
		} else {
			const refsAtOffset = (this.refsByOffset[offset] = this.refsByOffset[offset] ?? {
				at: new DoublyLinkedList(),
			});
			const atRefs = (refsAtOffset.at = refsAtOffset.at ?? new DoublyLinkedList());

			lref.link(this.segment, offset, atRefs.push(lref).last);

			this.refCount++;
		}
		validateRefCount?.(this);
	}

	/**
	 * Removes a local reference from the collection.
	 * @remarks This method should only be called by mergeTree.
	 */
	public removeLocalRef(lref: LocalReferencePosition): LocalReferencePosition | undefined {
		if (this.has(lref)) {
			assertLocalReferences(lref);

			const node = lref.getListNode();
			node?.list?.remove(node);

			lref.link(undefined, 0, undefined);

			this.refCount--;
			validateRefCount?.(this);
			return lref;
		}
	}

	/**
	 *
	 * Called by 'append()' implementations to append local refs from the given 'other' segment to the
	 * end of 'this' segment.
	 *
	 * Note: This method should be invoked after the caller has ensured that segments can be merged,
	 * but before 'this' segment's cachedLength has changed, or the adjustment to the local refs
	 * will be incorrect.
	 *
	 * @param other - Segment whose local references are transferred to this segment.
	 * @remarks This method should only be called by mergeTree.
	 *
	 * The transfer is not rolled back if a tracking-group callback throws.
	 * The receiver retains the buckets, but reference positions may be only partially rebound.
	 */
	public append(other: ISegmentInternal): void {
		const otherRefs = other.localRefs;
		if (otherRefs === undefined || otherRefs.empty) {
			// Keep offsets aligned even when the appended segment has no references.
			this.refsByOffset.length += other.cachedLength;
			return;
		}
		assert(
			this.refsByOffset.length === this.segment.cachedLength,
			0x2be /* "LocalReferences array contains a gap" */,
		);
		assert(otherRefs !== this, "Cannot append a local reference collection to itself");
		const offset = this.refsByOffset.length;
		const { count, buckets } = otherRefs.takeReferencesForAppend();
		this.refCount += count;
		// Adopt buckets before relinking so a throwing tracking callback cannot orphan them.
		// Avoid a spread call, which can exceed the argument limit for large transfers.
		for (const bucket of buckets) {
			this.refsByOffset.push(bucket);
		}
		for (const lref of createLocalReferenceIterator(buckets)) {
			assertLocalReferences(lref);
			lref.link(this.segment, lref.getOffset() + offset, lref.getListNode());
		}
	}

	/**
	 * Transfers this collection's buckets and count to the caller for a segment append.
	 * Reference positions and list-node identities are unchanged.
	 *
	 * @remarks This consumes the donor's offset storage; it is not a general-purpose clear.
	 * The donor segment is expected to be merged away. Do not add references or append
	 * further content through this collection after the handoff.
	 */
	public takeReferencesForAppend(): LocalReferenceTransfer {
		const transfer = { count: this.refCount, buckets: this.refsByOffset };
		this.refCount = 0;
		this.refsByOffset = [];
		return transfer;
	}

	/**
	 * Returns true of the local reference is in the collection, otherwise false.
	 *
	 * @remarks This method should only be called by mergeTree.
	 */
	public has(lref: ReferencePosition): boolean {
		if (
			!(lref instanceof LocalReference) ||
			refTypeIncludesFlag(lref, ReferenceType.Transient)
		) {
			return false;
		}
		const seg = lref.getSegment();
		if (seg !== this.segment) {
			return false;
		}
		// we should be able to optimize finding the
		// list head
		const listNode = lref.getListNode();
		if (listNode === undefined) {
			return false;
		}
		const offset = lref.getOffset();
		const refsAtOffset = this.refsByOffset[offset];
		if (
			!!refsAtOffset?.before?.includes(listNode) ||
			!!refsAtOffset?.at?.includes(listNode) ||
			!!refsAtOffset?.after?.includes(listNode)
		) {
			return true;
		}
		return false;
	}

	/**
	 * Splits this `LocalReferenceCollection` into the intervals [0, offset) and [offset, originalLength).
	 * Local references in the former half of this split will remain associated with the segment used on construction.
	 * Local references in the latter half of this split will be transferred to `splitSeg`,
	 * and its `localRefs` field will be set.
	 * @param offset - Offset into the original segment at which the collection should be split
	 * @param splitSeg - Split segment which originally corresponded to the indices [offset, originalLength)
	 * before splitting.
	 *
	 * @remarks This method should only be called by mergeTree.
	 */
	public split(offset: number, splitSeg: ISegmentInternal): void {
		if (this.empty) {
			// shrink the offset array when empty and splitting
			this.refsByOffset.length = offset;
		} else {
			const localRefs = new LocalReferenceCollection(
				splitSeg,
				this.refsByOffset.splice(offset, this.refsByOffset.length - offset),
			);

			splitSeg.localRefs = localRefs;
			for (const lref of localRefs) {
				assertLocalReferences(lref);
				lref.link(splitSeg, lref.getOffset() - offset, lref.getListNode());
				this.refCount--;
			}
		}
		validateRefCount?.(this);
	}

	/**
	 * Insert a reference before tombstoned references.
	 * @remarks This method should only be called by mergeTree.
	 */
	public addBeforeTombstones(...refs: Iterable<LocalReferencePosition>[]): void {
		const beforeRefs = this.refsByOffset[0]?.before ?? new DoublyLinkedList();

		if (this.refsByOffset[0]?.before === undefined) {
			const refsAtOffset = (this.refsByOffset[0] ??= { before: beforeRefs });
			refsAtOffset.before ??= beforeRefs;
		}

		let precedingRef: ListNode<LocalReferencePosition> | undefined;
		for (const iterable of refs) {
			for (const lref of iterable) {
				assertLocalReferences(lref);
				if (refTypeIncludesFlag(lref, ReferenceType.StayOnRemove)) {
					continue;
				} else if (refTypeIncludesFlag(lref, ReferenceType.SlideOnRemove)) {
					lref.callbacks?.beforeSlide?.(lref);
					precedingRef =
						precedingRef === undefined
							? beforeRefs.unshift(lref)?.first
							: beforeRefs.insertAfter(precedingRef, lref)?.first;
					lref.link(this.segment, 0, precedingRef);
					this.refCount++;
					lref.callbacks?.afterSlide?.(lref);
				} else {
					lref.link(undefined, 0, undefined);
				}
			}
		}
		validateRefCount?.(this);
	}
	/**
	 * Insert a reference after tombstoned references.
	 * @remarks This method should only be called by mergeTree.
	 */
	public addAfterTombstones(...refs: Iterable<LocalReferencePosition>[]): void {
		const lastOffset = this.segment.cachedLength - 1;
		const afterRefs = this.refsByOffset[lastOffset]?.after ?? new DoublyLinkedList();

		if (this.refsByOffset[lastOffset]?.after === undefined) {
			const refsAtOffset = (this.refsByOffset[lastOffset] ??= { after: afterRefs });
			refsAtOffset.after ??= afterRefs;
		}

		for (const iterable of refs) {
			for (const lref of iterable) {
				assertLocalReferences(lref);
				if (refTypeIncludesFlag(lref, ReferenceType.StayOnRemove)) {
					continue;
				} else if (refTypeIncludesFlag(lref, ReferenceType.SlideOnRemove)) {
					lref.callbacks?.beforeSlide?.(lref);
					afterRefs.push(lref);
					lref.link(this.segment, lastOffset, afterRefs.last);
					this.refCount++;
					lref.callbacks?.afterSlide?.(lref);
				} else {
					lref.link(undefined, 0, undefined);
				}
			}
		}
		validateRefCount?.(this);
	}

	/**
	 * Determines if a reference is after tombstoned references.
	 * @remarks This method should only be called by mergeTree.
	 */
	public isAfterTombstone(lref: LocalReferencePosition): boolean {
		const after = this.refsByOffset[lref.getOffset()]?.after;
		if (after) {
			assertLocalReferences(lref);
			return after.includes(lref.getListNode());
		}
		return false;
	}

	/**
	 * Walks all of the references in a collection.
	 * @remarks This method should only be called by mergeTree.
	 */
	public walkReferences(
		visitor: (lref: LocalReferencePosition) => boolean | void | undefined,
		start?: LocalReferencePosition,
		forward: boolean = true,
	): boolean {
		if (start !== undefined) {
			if (!this.has(start)) {
				throw new UsageError("start must be in collection");
			}
			assertLocalReferences(start);
		}
		let offset = start?.getOffset() ?? (forward ? 0 : this.segment.cachedLength - 1);

		const offsetPositions: DoublyLinkedList<IRefsAtOffset[keyof IRefsAtOffset]> =
			new DoublyLinkedList();
		offsetPositions.push(
			this.refsByOffset[offset]?.before,
			this.refsByOffset[offset]?.at,
			this.refsByOffset[offset]?.after,
		);

		const startNode = start?.getListNode();
		const startList = startNode?.list;

		if (startList !== undefined) {
			// Discard the buckets (before/at/after) which precede the bucket containing `start`,
			// so the walk begins at that bucket. `listWalker` then resumes mid-bucket at `startNode`.
			if (forward) {
				while (!offsetPositions.empty && offsetPositions.first?.data !== startList) {
					offsetPositions.shift();
				}
			} else {
				while (!offsetPositions.empty && offsetPositions.last?.data !== startList) {
					offsetPositions.pop();
				}
			}
		}

		const listWalker = (pos: DoublyLinkedList<LocalReferencePosition>): boolean => {
			return walkList(
				pos,
				(node) => visitor(node.data),
				startList === pos ? startNode : undefined,
				forward,
			);
		};
		const increment = forward ? 1 : -1;
		while (offset >= 0 && offset < this.refsByOffset.length) {
			while (offsetPositions.length > 0) {
				const offsetPos = forward ? offsetPositions.shift() : offsetPositions.pop();
				if (offsetPos?.data !== undefined && listWalker(offsetPos.data) === false) {
					return false;
				}
			}
			offset += increment;
			offsetPositions.push(
				this.refsByOffset[offset]?.before,
				this.refsByOffset[offset]?.at,
				this.refsByOffset[offset]?.after,
			);
		}
		return true;
	}
}
