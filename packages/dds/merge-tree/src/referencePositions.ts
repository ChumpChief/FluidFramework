/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { SlidingPreference } from "./localReference.js";
import { ISegment } from "./mergeTreeNodes.js";
import { ReferenceType } from "./ops.js";
import { PropertySet } from "./properties.js";
import { isMergeNodeInfo } from "./segmentInfos.js";

/**
 * @internal
 */
export const reservedTileLabelsKey = "referenceTileLabels";
/**
 * @internal
 */
export const reservedRangeLabelsKey = "referenceRangeLabels";

/**
 * Determines if the given reference type includes the given flags.
 * @internal
 */
export function refTypeIncludesFlag(
	refPosOrType: ReferencePosition | ReferenceType,
	flags: ReferenceType,
): boolean {
	const refType = typeof refPosOrType === "number" ? refPosOrType : refPosOrType.refType;
	// eslint-disable-next-line no-bitwise
	return (refType & flags) !== 0;
}

/**
 * Gets the tile labels stored in the given reference position.
 * @legacy
 * @alpha
 */
export const refGetTileLabels = (refPos: ReferencePosition): string[] | undefined =>
	refTypeIncludesFlag(refPos, ReferenceType.Tile) && refPos.properties
		? (refPos.properties[reservedTileLabelsKey] as string[])
		: undefined;

/**
 * Determines if a reference position has the given tile label.
 * @legacy
 * @alpha
 */
export function refHasTileLabel(refPos: ReferencePosition, label: string): boolean {
	const tileLabels = refGetTileLabels(refPos);
	return tileLabels?.includes(label) ?? false;
}

/**
 * Determines if a reference position has any tile labels.
 * @internal
 */
export function refHasTileLabels(refPos: ReferencePosition): boolean {
	return refGetTileLabels(refPos) !== undefined;
}

/**
 * Represents a reference to a place within a merge tree. This place conceptually remains stable over time
 * by referring to a particular segment and offset within that segment.
 * Thus, this reference's character position changes as the tree is edited.
 * @legacy
 * @alpha
 */
export interface ReferencePosition {
	/**
	 * Properties associated with this reference
	 */
	properties?: PropertySet;

	/**
	 * The direction for this reference position to slide when the segment it
	 * points to is removed. See {@link (SlidingPreference:type)} for additional context.
	 *
	 * Defaults to SlidingPreference.Forward
	 */
	slidingPreference?: SlidingPreference;

	refType: ReferenceType;

	/**
	 * Gets the segment that this reference position is semantically associated with. Returns undefined iff the
	 * reference became detached from the string.
	 */
	getSegment(): ISegment | undefined;

	/**
	 * Gets the offset for this reference position within its associated segment.
	 *
	 * @example
	 *
	 * If a merge-tree has 3 leaf segments ["hello", " ", "world"] and a ReferencePosition refers to the "l"
	 * in "world", that reference's offset would be 3 as "l" is the character at index 3 within "world".
	 */
	getOffset(): number;

	isLeaf(): this is ISegment;
}

/**
 * @internal
 */
export const DetachedReferencePosition = -1;

/**
 * Finds the minimum reference position.
 * @internal
 */
export function minReferencePosition<T extends ReferencePosition>(a: T, b: T): T {
	return compareReferencePositions(a, b) < 0 ? a : b;
}

/**
 * Finds the maximum reference position.
 * @internal
 */
export function maxReferencePosition<T extends ReferencePosition>(a: T, b: T): T {
	return compareReferencePositions(a, b) > 0 ? a : b;
}

/**
 * Compares two reference positions.
 * @internal
 */
export function compareReferencePositions(a: ReferencePosition, b: ReferencePosition): number {
	const aSeg = a.getSegment();
	const bSeg = b.getSegment();
	if (aSeg === bSeg) {
		return a.getOffset() - b.getOffset();
	} else {
		return !isMergeNodeInfo(aSeg) || (isMergeNodeInfo(bSeg) && aSeg.ordinal < bSeg.ordinal)
			? -1
			: 1;
	}
}
