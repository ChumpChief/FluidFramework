/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert, unreachableCase } from "@fluidframework/core-utils/internal";
import type {
	AttributionKey,
	DetachedAttributionKey,
	OpAttributionKey,
} from "@fluidframework/runtime-definitions/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";

import type { ISegment } from "./mergeTreeNodes.js";

/**
 * @legacy @beta
 */
export interface SequenceOffsets {
	/**
	 * Parallel array with posBreakpoints which tracks the seq of insertion.
	 *
	 * @example
	 *
	 * If seqs is [45, 46] and posBreakpoints is [0, 3], the section of the string
	 * between offsets 0 and 3 was inserted at seq 45 and the section of the string between
	 * 3 and the length of the string was inserted at seq 46.
	 *
	 * @remarks We use null here rather than undefined as round-tripping through JSON converts
	 * undefineds to null anyway
	 */
	// eslint-disable-next-line @rushstack/no-new-null
	seqs: (number | AttributionKey | null)[];
	posBreakpoints: number[];
}

/**
 * @legacy @beta
 */
export interface SerializedAttributionCollection extends SequenceOffsets {
	channels?: { [name: string]: SequenceOffsets };
	/* Total length; only necessary for validation */
	length: number;
}

/**
 * @legacy @beta
 */
export interface IAttributionCollectionSpec<T> {
	// eslint-disable-next-line @rushstack/no-new-null
	root: Iterable<{ offset: number; key: T | null }>;
	// eslint-disable-next-line @rushstack/no-new-null
	channels?: { [name: string]: Iterable<{ offset: number; key: T | null }> };
	length: number;
}

/**
 * @legacy @beta
 * @sealed
 */
export interface IAttributionCollectionSerializer {
	/***/
	serializeAttributionCollections(
		segments: Iterable<{
			attribution?: IAttributionCollection<AttributionKey>;
			cachedLength: number;
		}>,
	): SerializedAttributionCollection;

	/**
	 * Populates attribution information on segments using the provided summary.
	 */
	populateAttributionCollections(
		segments: Iterable<ISegment>,
		summary: SerializedAttributionCollection,
	): void;
}

/**
 * @legacy @beta
 */
export interface IAttributionCollection<T> {
	/**
	 * Retrieves the attribution key associated with the provided offset.
	 * @param channel - When specified, gets an attribution key associated with a particular channel.
	 */
	getAtOffset(offset: number, channel?: string): AttributionKey | undefined;

	/**
	 * Retrieves all the [Offset, Attribution key] pairs for the provided offset range. Note:
	 * The returned array is sorted by offset.
	 * The first offset in response could be lower than the startOffset as the Attribution Key for the startOffset
	 * could start at a lower offset than the startOffset in case where Attribution key offset boundaries don't
	 * align exactly with startOffset.
	 * Example: If the Attribution Offsets in the segment is [0, 10, 20, 30, 40] and request is for (startOffset: 5, endOffset: 25),
	 * then result would be [(offset: 0, key: key1), (offset:10, key: key2), (offset:20, key: key3)].
	 * @param channel - When specified, gets attribution keys associated with a particular channel.
	 * @returns undefined if the provided channel is not found or list of attribution keys along with
	 * the corresponding offset start boundary.
	 */
	getKeysInOffsetRange(
		startOffset: number,
		endOffset?: number,
		channel?: string,
	): { offset: number; key: AttributionKey }[] | undefined;

	/**
	 * Total length of all attribution keys in this collection.
	 */
	readonly length: number;

	readonly channelNames: Iterable<string>;

	/**
	 * Retrieve all key/offset pairs stored on this segment. Entries should be ordered by offset, such that
	 * the `i`th result's attribution key applies to offsets in the open range between the `i`th offset and the
	 * `i+1`th offset.
	 * The last entry's key applies to the open interval from the last entry's offset to this collection's length.
	 */
	getAll(): IAttributionCollectionSpec<T>;

	/***/
	splitAt(pos: number): IAttributionCollection<T>;

	/***/
	append(other: IAttributionCollection<T>): void;

	/***/
	clone(): IAttributionCollection<T>;

	/**
	 * Updates this collection with new attribution data.
	 * @param name - Name of the channel that requires an update. Undefined signifies the root channel.
	 * Updates apply only to the individual channel (i.e. if an attribution policy needs to update the root
	 * channel and 4 other channels, it should call `.update` 5 times).
	 * @param channel - Updated collection for that channel.
	 */
	update(name: string | undefined, channel: IAttributionCollection<T>): void;
}

// note: treats null and undefined as equivalent
export function areEqualAttributionKeys(
	// eslint-disable-next-line @rushstack/no-new-null
	a: AttributionKey | null | undefined,
	// eslint-disable-next-line @rushstack/no-new-null
	b: AttributionKey | null | undefined,
): boolean {
	if (!a && !b) {
		return true;
	}

	if (!a || !b) {
		return false;
	}

	if (a.type !== b.type) {
		return false;
	}

	// Note: TS can't narrow the type of b inside this switch statement, hence the need for casting.
	switch (a.type) {
		case "op": {
			return a.seq === (b as OpAttributionKey).seq;
		}
		case "detached": {
			return a.id === (b as DetachedAttributionKey).id;
		}
		case "local": {
			return true;
		}
		default: {
			unreachableCase(a, "Unhandled AttributionKey type");
		}
	}
}

interface AttributionCollectionInit {
	readonly length: number;
	readonly rootEntries: IAttributionCollectionSpec<AttributionKey>["root"];
	/**
	 * The channel map is copied, but its collections are retained by reference.
	 */
	readonly channels?: Readonly<Record<string, AttributionCollection>>;
}

/**
 * Reads segment-relative entries from one serialized attribution stream in order.
 */
class AttributionEntryReader {
	private readonly seqs: SequenceOffsets["seqs"];
	private readonly posBreakpoints: SequenceOffsets["posBreakpoints"];
	private curIndex = 0;
	private cumulativeSegPos = 0;

	public constructor({ seqs, posBreakpoints }: SequenceOffsets) {
		if (seqs.length === 0) {
			assert(
				posBreakpoints.length === 0,
				0x9e1 /* seqs and posBreakpoints length should match */,
			);
		}
		this.seqs = seqs;
		this.posBreakpoints = posBreakpoints;
	}

	/**
	 * Reads entries for the next segment, with offsets relative to that segment's start.
	 * Advances the reader by `segmentLength`, carrying forward any key already active at the start.
	 *
	 * @param segmentLength - Length of the next consecutive segment.
	 */
	public readEntries(
		segmentLength: number,
	): IAttributionCollectionSpec<AttributionKey>["root"] {
		const segmentEnd = this.cumulativeSegPos + segmentLength;
		const rootEntries: { offset: number; key: AttributionKey | null }[] = [];
		if (this.curIndex > 0 && this.posBreakpoints[this.curIndex] > this.cumulativeSegPos) {
			this.curIndex--;
		}

		while (
			this.curIndex < this.posBreakpoints.length &&
			this.posBreakpoints[this.curIndex] < segmentEnd
		) {
			rootEntries.push({
				offset: Math.max(this.posBreakpoints[this.curIndex] - this.cumulativeSegPos, 0),
				key: this.decodeKey(this.curIndex),
			});
			this.curIndex++;
		}

		if (rootEntries.length === 0 && this.curIndex > 0) {
			rootEntries.push({ offset: 0, key: this.decodeKey(this.curIndex - 1) });
		}

		this.cumulativeSegPos = segmentEnd;
		return rootEntries;
	}

	private decodeKey(index: number): AttributionKey | null {
		const seq = this.seqs[index];
		return typeof seq === "object" ? seq : { type: "op", seq };
	}
}

export class AttributionCollection implements IAttributionCollection<AttributionKey> {
	private _length: number;
	private offsets: number[] = [];
	private keys: (AttributionKey | null)[] = [];

	private channels?: { [name: string]: AttributionCollection };

	private get channelEntries(): [string, AttributionCollection][] {
		return Object.entries(this.channels ?? {});
	}

	public constructor({ length, rootEntries, channels }: AttributionCollectionInit) {
		this._length = length;
		for (const { offset, key } of rootEntries) {
			this.offsets.push(offset);
			this.keys.push(key);
		}
		if (channels !== undefined) {
			for (const channel of Object.values(channels)) {
				assert(
					channel.length === length,
					"AttributionCollection channels must have the same length as the collection",
				);
			}
			this.channels = { ...channels };
		}
	}

	public get channelNames(): string[] {
		return Object.keys(this.channels ?? {});
	}

	public getAtOffset(offset: number): AttributionKey;
	public getAtOffset(offset: number, channel: string): AttributionKey | undefined;
	public getAtOffset(offset: number, channel?: string): AttributionKey | undefined {
		if (channel !== undefined) {
			const subCollection = this.channels?.[channel];
			return subCollection?.getAtOffset(offset);
		}
		assert(offset >= 0 && offset < this._length, 0x443 /* Requested offset should be valid */);
		return this.get(this.findIndex(offset));
	}

	public getKeysInOffsetRange(
		startOffset: number,
		endOffset?: number,
	): { offset: number; key: AttributionKey }[];
	public getKeysInOffsetRange(
		startOffset: number,
		endOffset?: number,
		channel?: string,
	): { offset: number; key: AttributionKey }[] | undefined;
	public getKeysInOffsetRange(
		startOffset: number,
		endOffset?: number,
		channel?: string,
	): { offset: number; key: AttributionKey }[] | undefined {
		if (startOffset < 0 || startOffset >= this._length) {
			throw new UsageError("startOffset should be valid and in range");
		}
		if (
			endOffset !== undefined &&
			(endOffset < 0 || endOffset >= this._length || startOffset > endOffset)
		) {
			throw new UsageError("endOffset should be valid and in range");
		}

		if (channel !== undefined) {
			const subCollection = this.channels?.[channel];
			return subCollection?.getKeysInOffsetRange(startOffset, endOffset);
		}
		const result: { offset: number; key: AttributionKey }[] = [];
		let index = this.findIndex(startOffset);
		let attributionKey = this.get(index);
		if (attributionKey !== undefined) {
			result.push({ offset: this.offsets[index], key: attributionKey });
		}
		index++;
		const endOffsetVal = endOffset ?? Number.MAX_SAFE_INTEGER;
		while (index < this.offsets.length && endOffsetVal >= this.offsets[index]) {
			attributionKey = this.get(index);
			if (attributionKey !== undefined) {
				result.push({ offset: this.offsets[index], key: attributionKey });
			}
			index++;
		}
		return result;
	}

	private findIndex(offset: number): number {
		// Note: maximum length here is 256 for text segments. Perf testing shows that linear scan beats binary search
		// for attribution collections with under ~64 entries, and even at maximum size (which would require a maximum
		// length segment with every offset having different attribution), getAtOffset is on the order of 100ns.
		let i = 0;
		while (i < this.offsets.length && offset > this.offsets[i]) {
			i++;
		}
		return this.offsets[i] === offset ? i : i - 1;
	}

	private get(index: number): AttributionKey | undefined {
		const key = this.keys[index];
		return key ?? undefined;
	}

	public get length(): number {
		return this._length;
	}

	/**
	 * Splits this attribution collection into two with entries for [0, pos) and [pos, length).
	 */
	public splitAt(pos: number): AttributionCollection {
		const splitIndex = this.findIndex(pos);
		const rootEntries: { offset: number; key: AttributionKey | null }[] = [];
		for (let i = Math.max(splitIndex, 0); i < this.keys.length; i++) {
			rootEntries.push({ offset: Math.max(this.offsets[i] - pos, 0), key: this.keys[i] });
		}
		const splitCollection = new AttributionCollection({
			length: this.length - pos,
			rootEntries,
			channels:
				this.channels === undefined
					? undefined
					: Object.fromEntries(
							this.channelEntries.map(([name, collection]) => [name, collection.splitAt(pos)]),
						),
		});

		const spliceIndex = this.offsets[splitIndex] === pos ? splitIndex : splitIndex + 1;
		this.keys.splice(spliceIndex);
		this.offsets.splice(spliceIndex);
		this._length = pos;
		return splitCollection;
	}

	public append(other: AttributionCollection): void {
		const lastEntry = this.keys[this.keys.length - 1];
		const rootEntries = other.getRootEntries();
		for (let i = 0; i < rootEntries.length; i++) {
			const { offset, key } = rootEntries[i];
			if (i !== 0 || !areEqualAttributionKeys(lastEntry, key)) {
				this.offsets.push(offset + this.length);
				this.keys.push(key);
			}
		}

		const otherChannels = other.getChannels();
		// Append incoming channels, padding the receiver's prefix when needed.
		if (otherChannels !== undefined) {
			this.channels ??= {};
			for (const [channelName, sourceChannel] of Object.entries(otherChannels)) {
				const targetChannel = (this.channels[channelName] ??= new AttributionCollection({
					length: this.length,
					// eslint-disable-next-line unicorn/no-null
					rootEntries: [{ offset: 0, key: null }],
				}));
				targetChannel.append(sourceChannel);
			}
		}

		// Prevent receiver-only attribution from extending into the appended text.
		if (this.channels !== undefined) {
			for (const [channelName, targetChannel] of this.channelEntries) {
				if (otherChannels?.[channelName] === undefined) {
					targetChannel.append(
						new AttributionCollection({
							length: other.length,
							// eslint-disable-next-line unicorn/no-null
							rootEntries: [{ offset: 0, key: null }],
						}),
					);
				}
			}
		}
		this._length += other.length;
	}

	/**
	 * Returns copies of this collection's root entries without traversing named channels.
	 * Attribution keys are not deep-cloned.
	 */
	// eslint-disable-next-line @rushstack/no-new-null -- Explicit null entries are part of the legacy attribution format.
	public getRootEntries(): { offset: number; key: AttributionKey | null }[] {
		return this.keys.map((key, index) => ({ offset: this.offsets[index], key }));
	}

	/**
	 * Returns a shallow copy of the named-channel map, or undefined if no map has been initialized.
	 * Channel collections are shared with this instance; they are not cloned.
	 */
	public getChannels(): Record<string, AttributionCollection> | undefined {
		return this.channels === undefined ? undefined : { ...this.channels };
	}

	public getAll(): IAttributionCollectionSpec<AttributionKey> {
		const result: IAttributionCollectionSpec<AttributionKey> = {
			root: this.getRootEntries(),
			length: this.length,
		};
		if (this.channels !== undefined) {
			result.channels = {};
			for (const [key, collection] of this.channelEntries) {
				result.channels[key] = collection.getAll().root;
			}
		}
		return result;
	}

	public clone(): AttributionCollection {
		return new AttributionCollection({
			length: this.length,
			rootEntries: this.getRootEntries(),
			channels:
				this.channels === undefined
					? undefined
					: Object.fromEntries(
							this.channelEntries.map(([name, collection]) => [name, collection.clone()]),
						),
		});
	}

	public update(name: string | undefined, channel: AttributionCollection): void {
		assert(
			channel.length === this.length,
			0x5c0 /* AttributionCollection channel update should have consistent segment length */,
		);
		if (name === undefined) {
			const rootEntries = channel.getRootEntries();
			this.offsets = rootEntries.map(({ offset }) => offset);
			this.keys = rootEntries.map(({ key }) => key);
		} else {
			this.channels ??= {};
			if (this.channels[name] === undefined) {
				this.channels[name] = channel;
			} else {
				this.channels[name]?.update(undefined, channel);
			}
		}
	}

	/**
	 * Replaces attribution on each consecutive segment with the complete data from the summary.
	 * Empty root and named-channel streams are retained as empty collections.
	 */
	public static populateAttributionCollections(
		segments: Iterable<ISegment>,
		summary: SerializedAttributionCollection,
	): void {
		const { channels } = summary;
		assert(
			summary.seqs.length === summary.posBreakpoints.length,
			0x445 /* Invalid attribution summary blob provided */,
		);

		const rootReader = new AttributionEntryReader(summary);
		const channelReaders: [string, AttributionEntryReader][] = [];
		for (const [name, channelSummary] of Object.entries(channels ?? {})) {
			channelReaders.push([name, new AttributionEntryReader(channelSummary)]);
		}

		for (const segment of segments) {
			const length = segment.cachedLength;
			const rootEntries = rootReader.readEntries(length);
			let namedChannels: Record<string, AttributionCollection> | undefined;
			if (channelReaders.length > 0) {
				const channelEntries: [string, AttributionCollection][] = [];
				for (const [name, reader] of channelReaders) {
					channelEntries.push([
						name,
						new AttributionCollection({ length, rootEntries: reader.readEntries(length) }),
					]);
				}
				namedChannels = Object.fromEntries(channelEntries);
			}
			segment.attribution = new AttributionCollection({
				length,
				rootEntries,
				channels: namedChannels,
			});
		}
	}

	/**
	 * Condenses attribution information on consecutive segments into a `SerializedAttributionCollection`
	 *
	 * Note: this operates on segments rather than attribution collections directly so that it can handle cases
	 * where only some segments have attribution defined.
	 */
	public static serializeAttributionCollections(
		segments: Iterable<{
			attribution?: IAttributionCollection<AttributionKey>;
			cachedLength: number;
		}>,
	): SerializedAttributionCollection {
		const allCollectionSpecs: IAttributionCollectionSpec<AttributionKey>[] = [];

		const allChannelNames = new Set<string>();
		for (const segment of segments) {
			const collection =
				segment.attribution ??
				new AttributionCollection({
					length: segment.cachedLength,
					// eslint-disable-next-line unicorn/no-null
					rootEntries: [{ offset: 0, key: null }],
				});
			const spec = collection.getAll();
			allCollectionSpecs.push(spec);
			if (spec.channels) {
				for (const name of Object.keys(spec.channels)) {
					allChannelNames.add(name);
				}
			}
		}

		const extractSequenceOffsets = (
			getSpecEntries: (
				spec: IAttributionCollectionSpec<AttributionKey>,
			) => Iterable<{ offset: number; key: AttributionKey | null }>,
		): SerializedAttributionCollection => {
			const posBreakpoints: number[] = [];
			const seqs: (number | AttributionKey | null)[] = [];
			let mostRecentAttributionKey: AttributionKey | null | undefined;
			let cumulativePos = 0;

			for (const spec of allCollectionSpecs) {
				for (const { offset, key } of getSpecEntries(spec)) {
					assert(
						key?.type !== "local",
						0x5c1 /* local attribution keys should never be put in summaries */,
					);
					if (
						mostRecentAttributionKey === undefined ||
						!areEqualAttributionKeys(key, mostRecentAttributionKey)
					) {
						posBreakpoints.push(offset + cumulativePos);
						// eslint-disable-next-line unicorn/no-null
						seqs.push(key ? (key.type === "op" ? key.seq : key) : null);
					}
					mostRecentAttributionKey = key;
				}

				cumulativePos += spec.length;
			}

			return { seqs, posBreakpoints, length: cumulativePos };
		};

		const blobContents = extractSequenceOffsets((spec) => spec.root);
		if (allChannelNames.size > 0) {
			const channels: { [name: string]: SequenceOffsets } = {};
			for (const name of allChannelNames) {
				const { posBreakpoints, seqs } = extractSequenceOffsets(
					// eslint-disable-next-line unicorn/no-null
					(spec) => spec.channels?.[name] ?? [{ offset: 0, key: null }],
				);
				channels[name] = { posBreakpoints, seqs };
			}
			blobContents.channels = channels;
		}

		return blobContents;
	}
}
