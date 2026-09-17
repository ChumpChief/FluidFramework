/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/* eslint-disable unicorn/no-null */

import { strict as assert } from "node:assert";

import {
	type Generator,
	type IRandom,
	createWeightedGenerator,
	makeRandom,
	performFuzzActions,
	take,
} from "@fluid-private/stochastic-test-utils";
import type { AttributionKey } from "@fluidframework/runtime-definitions/internal";

import {
	AttributionCollection,
	type IAttributionCollectionSerializer,
	type SerializedAttributionCollection,
} from "../attributionCollection.js";
import { BaseSegment, type ISegment } from "../mergeTreeNodes.js";
import type { PropertySet } from "../properties.js";
import { TextSegment } from "../textSegment.js";

const opKey = (seq: number): AttributionKey => ({ type: "op", seq });
const detachedKey: AttributionKey = { type: "detached", id: 0 };

describe("AttributionCollection", () => {
	const makeCollectionWithChannel = ({
		length,
		seq,
	}: {
		length: number;
		seq: number;
	}): AttributionCollection => {
		return new AttributionCollection({
			type: "entries",
			length,
			rootEntries: [{ offset: 0, key: null }],
			channels: {
				foo: new AttributionCollection({
					type: "entries",
					length,
					rootEntries: [{ offset: 0, key: opKey(seq) }],
				}),
			},
		});
	};

	describe("constructor", () => {
		it("copies root entries without coalescing breakpoints", () => {
			const rootEntries = [
				{ offset: 0, key: null },
				{ offset: 1, key: null },
				{ offset: 2, key: opKey(10) },
				{ offset: 3, key: opKey(10) },
			];
			const expected = rootEntries.map((entry) => ({ ...entry }));
			const collection = new AttributionCollection({
				type: "entries",
				length: 4,
				rootEntries: rootEntries.values(),
			});

			rootEntries[0].key = opKey(20);
			rootEntries[1].offset = 0;
			rootEntries.length = 0;

			assert.deepEqual(collection.getAll(), { length: 4, root: expected });
		});

		it("distinguishes empty roots, explicit null entries, and an empty channel map", () => {
			for (const length of [0, 2]) {
				assert.deepEqual(
					new AttributionCollection({ type: "entries", length, rootEntries: [] }).getAll(),
					{
						length,
						root: [],
					},
				);
				assert.deepEqual(
					new AttributionCollection({
						type: "entries",
						length,
						rootEntries: [{ offset: 0, key: null }],
					}).getAll(),
					{ length, root: [{ offset: 0, key: null }] },
				);
				assert.deepEqual(
					new AttributionCollection({
						type: "entries",
						length,
						rootEntries: [],
						channels: {},
					}).getAll(),
					{ length, root: [], channels: {} },
				);
			}
		});

		it("copies the channel map but retains the supplied channel collections", () => {
			const channel = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(10) }],
			});
			const channels = { foo: channel };
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [],
				channels,
			});
			channels.foo = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [],
			});

			assert.deepEqual(collection.getAtOffset(0, "foo"), opKey(10));
			channel.update(
				undefined,
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(20) }],
				}),
			);
			assert.deepEqual(collection.getAtOffset(0, "foo"), opKey(20));
		});

		it("rejects channels with a different length", () => {
			assert.throws(
				() =>
					new AttributionCollection({
						type: "entries",
						length: 2,
						rootEntries: [],
						channels: {
							foo: new AttributionCollection({ type: "entries", length: 3, rootEntries: [] }),
						},
					}),
				/same length/,
			);
		});
	});

	describe(".getRootEntries", () => {
		it("returns independent entry records while retaining attribution key identities", () => {
			const key = opKey(10);
			const expected = [
				{ offset: 0, key },
				{ offset: 1, key: null },
			];
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: expected,
			});
			const rootEntries = collection.getRootEntries();
			assert.deepEqual(rootEntries, expected);
			assert.equal(rootEntries[0].key, key);

			rootEntries[0].offset = 1;
			rootEntries[0].key = null;
			rootEntries.push({ offset: 2, key: opKey(20) });
			assert.deepEqual(collection.getRootEntries(), expected);
		});

		it("reads and copies root entries without traversing named channels", () => {
			class UnreadableChannel extends AttributionCollection {
				public override getAll(): never {
					throw new Error("Root-only access must not traverse named channels");
				}
			}
			const expected = [{ offset: 0, key: opKey(10) }];
			const source = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: expected,
				channels: {
					nested: new UnreadableChannel({ type: "entries", length: 2, rootEntries: [] }),
				},
			});
			assert.deepEqual(source.getRootEntries(), expected);

			const destination = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [],
			});
			destination.update(undefined, source);
			assert.deepEqual(destination.getRootEntries(), expected);
			assert.deepEqual(destination.channelNames, []);
			source.update(
				undefined,
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: null }],
				}),
			);
			assert.deepEqual(destination.getRootEntries(), expected);
		});
	});

	describe(".getChannels", () => {
		it("returns an independent map containing the original channel collections", () => {
			const channel = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(10) }],
			});
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [],
				channels: { foo: channel },
			});
			const channels = collection.getChannels();
			assert(channels !== undefined);
			assert.equal(channels.foo, channel);
			channels.foo = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [],
			});
			channels.bar = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [],
			});
			assert.deepEqual(collection.channelNames, ["foo"]);
			assert.equal(collection.getChannels()?.foo, channel);

			channel.update(
				undefined,
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(20) }],
				}),
			);
			assert.deepEqual(collection.getAtOffset(0, "foo"), opKey(20));
		});

		it("distinguishes absent and initialized-empty channel maps", () => {
			assert.equal(
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [],
				}).getChannels(),
				undefined,
			);
			assert.deepEqual(
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [],
					channels: {},
				}).getChannels(),
				{},
			);
		});
	});

	describe(".getAtOffset", () => {
		describe("on a collection with a single entry", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 5,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});

			it("returns the entry for offsets within the length range", () => {
				for (let i = 0; i < 5; i++) {
					assert.deepEqual(collection.getAtOffset(i), opKey(100));
				}
			});

			it("throws for queries outside the range", () => {
				assert.throws(() => collection.getAtOffset(-1));
				assert.throws(() => collection.getAtOffset(5));
			});
		});

		describe("on a collection with multiple entries", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 3,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});
			collection.append(
				new AttributionCollection({
					type: "entries",
					length: 5,
					rootEntries: [{ offset: 0, key: opKey(101) }],
				}),
			);
			it("returns the correct entries", () => {
				for (let i = 0; i < 3; i++) {
					assert.deepEqual(collection.getAtOffset(i), opKey(100));
				}

				for (let i = 3; i < 8; i++) {
					assert.deepEqual(collection.getAtOffset(i), opKey(101));
				}
			});
		});

		it("works on collections with entries in channels", () => {
			const collection = makeCollectionWithChannel({ length: 3, seq: 300 });
			for (const offset of [0, 1, 2]) {
				assert.deepEqual(collection.getAtOffset(offset, "foo"), opKey(300));
			}
		});
	});

	describe(".getKeysInOffsetRange", () => {
		describe("on a collection with a single entry", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 5,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});

			it("returns the entry for offsets within the length range", () => {
				assert.deepEqual(
					collection.getKeysInOffsetRange(1),
					[{ offset: 0, key: opKey(100) }],
					"first",
				);
				assert.deepEqual(
					collection.getKeysInOffsetRange(4),
					[{ offset: 0, key: opKey(100) }],
					"second",
				);
				assert.deepEqual(
					collection.getKeysInOffsetRange(1, 4),
					[{ offset: 0, key: opKey(100) }],
					"third",
				);
				assert.deepEqual(
					collection.getKeysInOffsetRange(0, 4),
					[{ offset: 0, key: opKey(100) }],
					"fourth",
				);
			});

			it("throws for queries outside the range", () => {
				assert.throws(() => collection.getKeysInOffsetRange(-1));
				assert.throws(() => collection.getKeysInOffsetRange(7));
				assert.throws(() => collection.getKeysInOffsetRange(0, -1));
				assert.throws(() => collection.getKeysInOffsetRange(1, 7));
				assert.throws(() => collection.getKeysInOffsetRange(2, 1));
			});
		});

		describe("on a collection with multiple entries", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 10,
				rootEntries: [{ offset: 0, key: opKey(10) }],
			});
			collection.append(
				new AttributionCollection({
					type: "entries",
					length: 10,
					rootEntries: [{ offset: 0, key: opKey(20) }],
				}),
			);
			collection.append(
				new AttributionCollection({
					type: "entries",
					length: 10,
					rootEntries: [{ offset: 0, key: opKey(30) }],
				}),
			);
			collection.append(
				new AttributionCollection({
					type: "entries",
					length: 10,
					rootEntries: [{ offset: 0, key: opKey(40) }],
				}),
			);
			collection.append(
				new AttributionCollection({
					type: "entries",
					length: 10,
					rootEntries: [{ offset: 0, key: opKey(50) }],
				}),
			);

			it("returns the correct entries", () => {
				assert.deepEqual(collection.getKeysInOffsetRange(15, 25), [
					{ offset: 10, key: { type: "op", seq: 20 } },
					{ offset: 20, key: { type: "op", seq: 30 } },
				]);
				assert.deepEqual(collection.getKeysInOffsetRange(15, 19), [
					{ offset: 10, key: { type: "op", seq: 20 } },
				]);
				assert.deepEqual(collection.getKeysInOffsetRange(15, 49), [
					{ offset: 10, key: { type: "op", seq: 20 } },
					{ offset: 20, key: { type: "op", seq: 30 } },
					{ offset: 30, key: { type: "op", seq: 40 } },
					{ offset: 40, key: { type: "op", seq: 50 } },
				]);
				assert.deepEqual(collection.getKeysInOffsetRange(15, 40), [
					{ offset: 10, key: { type: "op", seq: 20 } },
					{ offset: 20, key: { type: "op", seq: 30 } },
					{ offset: 30, key: { type: "op", seq: 40 } },
					{ offset: 40, key: { type: "op", seq: 50 } },
				]);
				assert.deepEqual(collection.getKeysInOffsetRange(0), [
					{ offset: 0, key: { type: "op", seq: 10 } },
					{ offset: 10, key: { type: "op", seq: 20 } },
					{ offset: 20, key: { type: "op", seq: 30 } },
					{ offset: 30, key: { type: "op", seq: 40 } },
					{ offset: 40, key: { type: "op", seq: 50 } },
				]);
			});
		});

		it("works on collections with entries in channels", () => {
			const collection = makeCollectionWithChannel({ length: 3, seq: 300 });
			assert.deepEqual(collection.getKeysInOffsetRange(1, undefined, "foo"), [
				{ offset: 0, key: opKey(300) },
			]);
		});
	});

	describe(".splitAt", () => {
		it("preserves empty roots without introducing undefined entries", () => {
			for (const pos of [0, 2, 4]) {
				const collection = new AttributionCollection({
					type: "entries",
					length: 4,
					rootEntries: [],
				});
				const splitCollection = collection.splitAt(pos);
				assert.deepEqual(collection.getAll(), { length: pos, root: [] });
				assert.deepEqual(splitCollection.getAll(), { length: 4 - pos, root: [] });
			}
		});

		it("splits channel breakpoints without sharing the resulting collections", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 4,
				rootEntries: [],
				channels: {
					foo: new AttributionCollection({
						type: "entries",
						length: 4,
						rootEntries: [
							{ offset: 0, key: null },
							{ offset: 1, key: opKey(10) },
							{ offset: 3, key: null },
						],
					}),
				},
			});
			const splitCollection = collection.splitAt(2);
			assert.deepEqual(collection.getAll(), {
				length: 2,
				root: [],
				channels: {
					foo: [
						{ offset: 0, key: null },
						{ offset: 1, key: opKey(10) },
					],
				},
			});
			assert.deepEqual(splitCollection.getAll(), {
				length: 2,
				root: [],
				channels: {
					foo: [
						{ offset: 0, key: opKey(10) },
						{ offset: 1, key: null },
					],
				},
			});
			splitCollection.update(
				"foo",
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(20) }],
				}),
			);
			assert.deepEqual(collection.getAtOffset(1, "foo"), opKey(10));
		});

		describe("on a collection with 3 entries", () => {
			let collection: AttributionCollection;
			beforeEach(() => {
				collection = new AttributionCollection({
					type: "entries",
					length: 3,
					rootEntries: [{ offset: 0, key: opKey(100) }],
				});
				collection.append(
					new AttributionCollection({
						type: "entries",
						length: 2,
						rootEntries: [{ offset: 0, key: opKey(101) }],
					}),
				);
				collection.append(
					new AttributionCollection({
						type: "entries",
						length: 1,
						rootEntries: [{ offset: 0, key: opKey(102) }],
					}),
				);
			});

			it("can split on non-breakpoints", () => {
				const splitCollection = collection.splitAt(4);
				assert.deepEqual(collection.getAll().root, [
					{ offset: 0, key: opKey(100) },
					{ offset: 3, key: opKey(101) },
				]);
				assert.equal(collection.length, 4);
				assert.deepEqual(splitCollection.getAll().root, [
					{ offset: 0, key: opKey(101) },
					{ offset: 1, key: opKey(102) },
				]);
				assert.equal(splitCollection.length, 2);
			});

			it("can split on breakpoints", () => {
				const splitCollection = collection.splitAt(5);
				assert.deepEqual(collection.getAll().root, [
					{ offset: 0, key: opKey(100) },
					{ offset: 3, key: opKey(101) },
				]);
				assert.equal(collection.length, 5);
				assert.deepEqual(splitCollection.getAll().root, [{ offset: 0, key: opKey(102) }]);
				assert.equal(splitCollection.length, 1);
			});
		});

		it("can split collection with a single value", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 5,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});
			const splitCollection = collection.splitAt(3);
			assert.equal(collection.length, 3);
			assert.equal(splitCollection.length, 2);
			assert.deepEqual(collection.getAll().root, [{ offset: 0, key: opKey(100) }]);
			assert.deepEqual(splitCollection.getAll().root, [{ offset: 0, key: opKey(100) }]);
		});

		it("splits channels", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 5,
				rootEntries: [{ offset: 0, key: null }],
			});
			collection.update(
				"foo",
				new AttributionCollection({
					type: "entries",
					length: 5,
					rootEntries: [{ offset: 0, key: opKey(100) }],
				}),
			);
			const splitCollection = collection.splitAt(2);
			assert.deepEqual(collection.getAll().channels, {
				foo: [{ offset: 0, key: opKey(100) }],
			});
			assert.deepEqual(splitCollection.getAll().channels, {
				foo: [{ offset: 0, key: opKey(100) }],
			});
		});
	});

	describe(".append", () => {
		it("modifies the receiving collection", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});
			assert.deepEqual(collection.getAll().root, [{ offset: 0, key: opKey(100) }]);
			collection.append(
				new AttributionCollection({
					type: "entries",
					length: 1,
					rootEntries: [{ offset: 0, key: opKey(101) }],
				}),
			);
			assert.deepEqual(collection.getAll().root, [
				{ offset: 0, key: opKey(100) },
				{ offset: 2, key: opKey(101) },
			]);
		});

		it("does not modify the argument collection", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});
			const appendedCollection = new AttributionCollection({
				type: "entries",
				length: 1,
				rootEntries: [{ offset: 0, key: opKey(101) }],
			});
			assert.deepEqual(appendedCollection.getAll().root, [{ offset: 0, key: opKey(101) }]);
			collection.append(appendedCollection);
			assert.deepEqual(appendedCollection.getAll().root, [{ offset: 0, key: opKey(101) }]);
		});

		it("coalesces referentially equal values at the join point", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});
			collection.append(
				new AttributionCollection({
					type: "entries",
					length: 7,
					rootEntries: [{ offset: 0, key: opKey(100) }],
				}),
			);
			assert.deepEqual(collection.getAll().root, [{ offset: 0, key: opKey(100) }]);
			assert.equal(collection.length, 9);
		});

		describe("appends channels", () => {
			it("processes incoming channels before receiver-only channels", () => {
				const appendOrder: string[] = [];
				class TrackedChannel extends AttributionCollection {
					public constructor(private readonly name: string) {
						super({
							type: "entries",
							length: 2,
							rootEntries: [{ offset: 0, key: opKey(10) }],
						});
					}

					public override append(other: AttributionCollection): void {
						appendOrder.push(this.name);
						super.append(other);
					}
				}
				const collection = new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [],
					channels: {
						receiverOnly: new TrackedChannel("receiver-only"),
						shared: new TrackedChannel("shared"),
					},
				});
				collection.append(
					new AttributionCollection({
						type: "entries",
						length: 3,
						rootEntries: [],
						channels: {
							shared: new AttributionCollection({
								type: "entries",
								length: 3,
								rootEntries: [{ offset: 0, key: opKey(20) }],
							}),
						},
					}),
				);

				assert.deepEqual(appendOrder, ["shared", "receiver-only"]);
			});

			for (const receiverHasMap of [false, true]) {
				for (const donorHasMap of [false, true]) {
					it(`preserves empty-map presence (receiver=${receiverHasMap}, donor=${donorHasMap})`, () => {
						const collection = new AttributionCollection({
							type: "entries",
							length: 2,
							rootEntries: [],
							channels: receiverHasMap ? {} : undefined,
						});
						const other = new AttributionCollection({
							type: "entries",
							length: 3,
							rootEntries: [],
							channels: donorHasMap ? {} : undefined,
						});
						collection.append(other);
						assert.equal(collection.length, 5);
						assert.deepEqual(
							collection.getAll().channels,
							receiverHasMap || donorHasMap ? {} : undefined,
						);
						assert.deepEqual(other.getChannels(), donorHasMap ? {} : undefined);
					});
				}
			}

			it("appends nested channels without flattening them or modifying the donor", () => {
				const nested = new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(10) }],
				});
				const collection = new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [],
					channels: {
						foo: new AttributionCollection({
							type: "entries",
							length: 2,
							rootEntries: [],
							channels: { nested },
						}),
					},
				});
				const donorNested = new AttributionCollection({
					type: "entries",
					length: 3,
					rootEntries: [{ offset: 0, key: opKey(20) }],
				});
				const other = new AttributionCollection({
					type: "entries",
					length: 3,
					rootEntries: [],
					channels: {
						foo: new AttributionCollection({
							type: "entries",
							length: 3,
							rootEntries: [],
							channels: { nested: donorNested },
						}),
					},
				});
				const expectedDonor = other.getAll();

				collection.append(other);

				assert.equal(collection.length, 5);
				assert.equal(nested.length, 5);
				assert.deepEqual(nested.getRootEntries(), [
					{ offset: 0, key: opKey(10) },
					{ offset: 2, key: opKey(20) },
				]);
				assert.equal(donorNested.length, 3);
				assert.deepEqual(donorNested.getRootEntries(), [{ offset: 0, key: opKey(20) }]);
				assert.deepEqual(other.getAll(), expectedDonor);
			});

			it("when both collections have the channel", () => {
				const appender = makeCollectionWithChannel({ length: 2, seq: 100 });
				appender.append(makeCollectionWithChannel({ length: 5, seq: 200 }));
				assert.deepEqual(appender.getAll(), {
					length: 7,
					root: [{ offset: 0, key: null }],
					channels: {
						foo: [
							{
								offset: 0,
								key: opKey(100),
							},
							{
								offset: 2,
								key: opKey(200),
							},
						],
					},
				});
			});

			it("when only appended collection has a channel", () => {
				const appender = new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: null }],
				});
				appender.append(makeCollectionWithChannel({ length: 5, seq: 200 }));
				assert.deepEqual(appender.getAll(), {
					length: 7,
					root: [{ offset: 0, key: null }],
					channels: {
						foo: [
							{
								offset: 0,
								key: null,
							},
							{
								offset: 2,
								key: opKey(200),
							},
						],
					},
				});
			});

			it("when only segment being appended to has a channel", () => {
				const appender = makeCollectionWithChannel({ length: 2, seq: 100 });
				appender.append(
					new AttributionCollection({
						type: "entries",
						length: 5,
						rootEntries: [{ offset: 0, key: null }],
					}),
				);
				assert.deepEqual(appender.getAll(), {
					length: 7,
					root: [{ offset: 0, key: null }],
					channels: {
						foo: [
							{
								offset: 0,
								key: opKey(100),
							},
							{
								offset: 2,
								key: null,
							},
						],
					},
				});
			});
		});
	});

	describe(".channelNames", () => {
		it("is empty when collection has no channels", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});
			assert.deepEqual(collection.channelNames, []);
		});

		it("returns all channels with content for collection with channels", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});
			collection.update(
				"foo",
				new AttributionCollection({ type: "entries", length: 2, rootEntries: [] }),
			);
			collection.update(
				"bar",
				new AttributionCollection({ type: "entries", length: 2, rootEntries: [] }),
			);
			assert.deepEqual(collection.channelNames, ["foo", "bar"]);
		});
	});

	describe(".populateAttributionCollections", () => {
		it("supports a single-pass iterable of segments", () => {
			const segments = [TextSegment.make("abc"), TextSegment.make("defg")];
			const summary: SerializedAttributionCollection = {
				length: 7,
				posBreakpoints: [0],
				seqs: [1],
				channels: { foo: { posBreakpoints: [0, 4], seqs: [2, 3] } },
			};
			const serializer: IAttributionCollectionSerializer = AttributionCollection;

			serializer.populateAttributionCollections(segments.values(), summary);

			assert.deepEqual(
				AttributionCollection.serializeAttributionCollections(segments),
				summary,
			);
		});

		for (const emptyRoot of [false, true]) {
			it(`replaces existing attribution with a complete summary (emptyRoot=${emptyRoot})`, () => {
				const segment = TextSegment.make("abc");
				const previous = new AttributionCollection({
					type: "entries",
					length: 3,
					rootEntries: [{ offset: 0, key: opKey(1) }],
					channels: {
						old: new AttributionCollection({
							type: "entries",
							length: 3,
							rootEntries: [{ offset: 0, key: opKey(2) }],
						}),
					},
				});
				segment.attribution = previous;
				const expectedPrevious = previous.getAll();
				AttributionCollection.populateAttributionCollections([segment], {
					length: 3,
					posBreakpoints: emptyRoot ? [] : [0],
					seqs: emptyRoot ? [] : [3],
					channels: { foo: { posBreakpoints: [0], seqs: [4] } },
				});

				assert.notEqual(segment.attribution, previous);
				assert.deepEqual(segment.attribution.getAll(), {
					length: 3,
					root: emptyRoot ? [] : [{ offset: 0, key: opKey(3) }],
					channels: { foo: [{ offset: 0, key: opKey(4) }] },
				});
				assert.deepEqual(previous.getAll(), expectedPrevious);
			});
		}

		it("correctly splits segment boundaries on breakpoints", () => {
			const segments = [{ cachedLength: 5 }, { cachedLength: 4 }] as ISegment[];
			AttributionCollection.populateAttributionCollections(segments, {
				length: 9,
				posBreakpoints: [0, 2, 5, 7],
				seqs: [10, 12, 15, 17],
			});
			assert.deepEqual(segments[0].attribution?.getAll().root, [
				{ offset: 0, key: opKey(10) },
				{ offset: 2, key: opKey(12) },
			]);

			assert.deepEqual(segments[1].attribution?.getAll().root, [
				{ offset: 0, key: opKey(15) },
				{ offset: 2, key: opKey(17) },
			]);

			for (const segment of segments) {
				assert.equal(segment.attribution?.length, segment.cachedLength);
			}
		});

		it("correctly splits segment boundaries between breakpoints", () => {
			const segments = [{ cachedLength: 4 }, { cachedLength: 5 }] as ISegment[];
			AttributionCollection.populateAttributionCollections(segments, {
				length: 9,
				posBreakpoints: [0, 2, 5, 7],
				seqs: [10, 12, 15, 17],
			});
			assert.deepEqual(segments[0].attribution?.getAll().root, [
				{ offset: 0, key: opKey(10) },
				{ offset: 2, key: opKey(12) },
			]);

			assert.deepEqual(segments[1].attribution?.getAll().root, [
				{ offset: 0, key: opKey(12) },
				{ offset: 1, key: opKey(15) },
				{ offset: 3, key: opKey(17) },
			]);

			for (const segment of segments) {
				assert.equal(segment.attribution?.length, segment.cachedLength);
			}
		});
	});

	describe("serializeAttributionCollections", () => {
		it("combines equal values on endpoints", () => {
			const segments = [
				{
					attribution: new AttributionCollection({
						type: "entries",
						length: 4,
						rootEntries: [{ offset: 0, key: opKey(0) }],
					}),
					cachedLength: 4,
				},
				{
					attribution: new AttributionCollection({
						type: "entries",
						length: 5,
						rootEntries: [{ offset: 0, key: opKey(0) }],
					}),
					cachedLength: 5,
				},
			] as unknown as ISegment[];
			const blob = AttributionCollection.serializeAttributionCollections(segments);
			assert.deepEqual(blob, {
				posBreakpoints: [0],
				seqs: [0],
				length: 9,
			});
		});
	});

	describe("serializeAttributionCollections and populateAttributionCollections round-trip", () => {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const seg = (length: number): ISegment => ({ cachedLength: length }) as ISegment;
		const testCases: {
			name: string;
			blob: SerializedAttributionCollection;
			segments: ISegment[];
		}[] = [
			{
				name: "no segments",
				blob: { length: 0, posBreakpoints: [], seqs: [] },
				segments: [],
			},
			{
				name: "empty root entries",
				blob: { length: 7, posBreakpoints: [], seqs: [] },
				segments: [seg(3), seg(4)],
			},
			{
				name: "explicit null root entry",
				blob: { length: 7, posBreakpoints: [0], seqs: [null] },
				segments: [seg(3), seg(4)],
			},
			{
				name: "channels without root entries",
				blob: {
					length: 7,
					posBreakpoints: [],
					seqs: [],
					channels: {
						foo: { posBreakpoints: [0, 3, 5], seqs: [4, null, 5] },
					},
				},
				segments: [seg(3), seg(4)],
			},
			{
				name: "empty named-channel entries",
				blob: {
					length: 7,
					posBreakpoints: [0],
					seqs: [3],
					channels: { foo: { posBreakpoints: [], seqs: [] } },
				},
				segments: [seg(3), seg(4)],
			},
			{
				name: "root with an unattributed prefix",
				blob: {
					length: 7,
					posBreakpoints: [2, 5],
					seqs: [1, 2],
				},
				segments: [seg(1), seg(2), seg(4)],
			},
			{
				name: "named channel with an unattributed prefix",
				blob: {
					length: 7,
					posBreakpoints: [0],
					seqs: [3],
					channels: { foo: { posBreakpoints: [2, 5], seqs: [1, 2] } },
				},
				segments: [seg(1), seg(2), seg(4)],
			},
			{
				name: "root and channels with independent breakpoints",
				blob: {
					length: 7,
					posBreakpoints: [0, 2, 6],
					seqs: [3, 4, null],
					channels: {
						foo: { posBreakpoints: [0, 3, 5], seqs: [2, null, 5] },
						bar: { posBreakpoints: [0, 1, 4], seqs: [detachedKey, 7, 8] },
					},
				},
				segments: [seg(1), seg(2), seg(4)],
			},
			{
				name: "channel name matching an object property",
				blob: {
					length: 3,
					posBreakpoints: [0],
					seqs: [1],
					channels: { constructor: { posBreakpoints: [0], seqs: [2] } },
				},
				segments: [seg(1), seg(2)],
			},
			{
				name: "single key",
				blob: {
					length: 3,
					posBreakpoints: [0],
					seqs: [51],
				},
				segments: [seg(3)],
			},
			{
				name: "several keys on a single segment",
				blob: {
					length: 7,
					posBreakpoints: [0, 1, 3, 5],
					seqs: [1, 2, 3, 4],
				},
				segments: [seg(7)],
			},
			{
				name: "key spanning multiple segments",
				blob: {
					length: 7,
					posBreakpoints: [0],
					seqs: [1],
				},
				segments: [seg(3), seg(4)],
			},
			{
				name: "key and segment boundary that align",
				blob: {
					length: 7,
					posBreakpoints: [0, 3],
					seqs: [0, 1],
				},
				segments: [seg(3), seg(4)],
			},
			{
				name: "detached attribution keys",
				blob: {
					length: 7,
					posBreakpoints: [0, 3],
					seqs: [1, detachedKey],
				},
				segments: [seg(3), seg(4)],
			},
			{
				name: "entry with channels",
				blob: {
					length: 7,
					posBreakpoints: [0, 5],
					seqs: [3, null],
					channels: {
						foo: {
							posBreakpoints: [0, 3, 5],
							seqs: [4, null, 5],
						},
					},
				},
				segments: [seg(3), seg(4)],
			},
		];

		for (const { name, blob, segments } of testCases) {
			it(name, () => {
				AttributionCollection.populateAttributionCollections(segments, blob);
				assert.deepEqual(
					AttributionCollection.serializeAttributionCollections(segments),
					blob,
				);
			});
		}
	});

	describe(".clone", () => {
		it("does not materialize root-entry snapshots", () => {
			class WithoutRootSnapshots extends AttributionCollection {
				public override getRootEntries(): never {
					throw new Error("Cloning must copy root arrays directly");
				}
			}
			const key = opKey(10);
			const rootEntries = [
				{ offset: 0, key },
				{ offset: 1, key },
				{ offset: 2, key: null },
			];
			const collection = new WithoutRootSnapshots({ type: "entries", length: 3, rootEntries });
			const copy = collection.clone();
			assert.deepEqual(copy.getRootEntries(), rootEntries);
			assert.equal(copy.getAtOffset(0), key);

			copy.splitAt(1);
			assert.equal(collection.length, 3);
			assert.equal(collection.getAtOffset(1), key);
			assert.equal(collection.getAtOffset(2), undefined);
		});

		it("copies readonly root arrays and recursively clones supplied channels", () => {
			const key = opKey(10);
			const offsets = [0, 1];
			const keys = [key, null];
			const channel = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(20) }],
			});
			const channelsToClone = { foo: channel };
			const copy = new AttributionCollection({
				type: "clone",
				length: 2,
				rootArrays: { offsets, keys },
				channelsToClone,
			});

			offsets.length = 0;
			keys.length = 0;
			channelsToClone.foo = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [],
			});
			channel.update(
				undefined,
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: null }],
				}),
			);

			assert.deepEqual(copy.getAll(), {
				length: 2,
				root: [
					{ offset: 0, key },
					{ offset: 1, key: null },
				],
				channels: { foo: [{ offset: 0, key: opKey(20) }] },
			});
			assert.equal(copy.getAtOffset(0), key);
			assert.notEqual(copy.getChannels()?.foo, channel);
		});

		it("rejects mismatched root arrays", () => {
			assert.throws(
				() =>
					new AttributionCollection({
						type: "clone",
						length: 2,
						rootArrays: { offsets: [0], keys: [] },
					}),
				/root arrays must have matching lengths/,
			);
		});

		it("captures root data before cloning channels", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(10) }],
			});
			class MutatingChannel extends AttributionCollection {
				public override clone(): AttributionCollection {
					const clonedChannel = super.clone();
					collection.append(
						new AttributionCollection({
							type: "entries",
							length: 1,
							rootEntries: [{ offset: 0, key: opKey(20) }],
						}),
					);
					return clonedChannel;
				}
			}
			collection.update(
				"foo",
				new MutatingChannel({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(30) }],
				}),
			);

			const copy = collection.clone();

			assert.equal(collection.length, 3);
			assert.deepEqual(copy.getAll(), {
				length: 2,
				root: [{ offset: 0, key: opKey(10) }],
				channels: { foo: [{ offset: 0, key: opKey(30) }] },
			});
		});

		it("preserves absent and initialized-empty channel maps", () => {
			for (const channels of [undefined, {}]) {
				const collection = new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [],
					channels,
				});
				assert.deepEqual(collection.clone().getAll(), collection.getAll());
			}
		});

		it("recursively clones nested channels", () => {
			const nestedClones: AttributionCollection[] = [];
			class TrackedAttributionCollection extends AttributionCollection {
				public override clone(): AttributionCollection {
					const clonedChannel = super.clone();
					nestedClones.push(clonedChannel);
					return clonedChannel;
				}
			}
			const nested = new TrackedAttributionCollection({
				type: "entries",
				length: 3,
				rootEntries: [{ offset: 0, key: opKey(10) }],
			});
			const channel = new AttributionCollection({
				type: "entries",
				length: 3,
				rootEntries: [],
				channels: { nested },
			});
			const collection = new AttributionCollection({
				type: "entries",
				length: 3,
				rootEntries: [],
				channels: { foo: channel },
			});

			const copy = collection.clone();
			assert.equal(nestedClones.length, 1);
			assert.notEqual(nestedClones[0], nested);
			const split = copy.splitAt(1);
			assert.equal(nestedClones[0].length, 1);
			assert.equal(split.length, 2);
			assert.equal(channel.length, 3);
			assert.equal(nested.length, 3);
			assert.deepEqual(nested.getAtOffset(2), opKey(10));
		});

		it("preserves empty roots and explicit null entries without sharing storage", () => {
			for (const length of [0, 2]) {
				for (const key of [undefined, null]) {
					const collection = new AttributionCollection({
						type: "entries",
						length,
						rootEntries: key === undefined ? [] : [{ offset: 0, key }],
					});
					collection.update(
						"foo",
						new AttributionCollection({
							type: "entries",
							length,
							rootEntries: [{ offset: 0, key: null }],
						}),
					);
					const expected = collection.getAll();
					const copy = collection.clone();
					assert.deepEqual(copy.getAll(), expected);

					copy.update(
						undefined,
						new AttributionCollection({
							type: "entries",
							length,
							rootEntries: [{ offset: 0, key: opKey(100) }],
						}),
					);
					copy.update(
						"foo",
						new AttributionCollection({
							type: "entries",
							length,
							rootEntries: [{ offset: 0, key: opKey(200) }],
						}),
					);
					assert.deepEqual(collection.getAll(), expected);
				}
			}
		});

		it("copies the original collection", () => {
			const collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: opKey(100) }],
			});
			const appendedCollection = new AttributionCollection({
				type: "entries",
				length: 1,
				rootEntries: [{ offset: 0, key: opKey(101) }],
			});
			const copy = collection.clone();
			collection.append(appendedCollection);
			assert.deepEqual(collection.getAll().root, [
				{ offset: 0, key: opKey(100) },
				{ offset: 2, key: opKey(101) },
			]);
			assert.deepEqual(copy.getAll().root, [{ offset: 0, key: opKey(100) }]);
		});

		it("copies channels", () => {
			const collection = makeCollectionWithChannel({ length: 2, seq: 25 });
			const appendedCollection = makeCollectionWithChannel({ length: 3, seq: 26 });
			const copy = collection.clone();
			collection.append(appendedCollection);
			assert.deepEqual(collection.getAll().channels?.foo, [
				{ offset: 0, key: opKey(25) },
				{ offset: 2, key: opKey(26) },
			]);
			assert.deepEqual(copy.getAll().channels?.foo, [{ offset: 0, key: opKey(25) }]);
		});
	});

	describe(".update", () => {
		let collection: AttributionCollection;
		beforeEach(() => {
			collection = new AttributionCollection({
				type: "entries",
				length: 2,
				rootEntries: [{ offset: 0, key: null }],
			});
			collection.update(
				"bar",
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(10) }],
				}),
			);
			assert.deepEqual(
				collection.getAtOffset(0, "foo"),
				undefined,
				"channel should be undefined on creation",
			);
		});

		afterEach(() => {
			assert.deepEqual(
				collection.getAtOffset(0, "bar"),
				opKey(10),
				"update should never modify unrelated channels",
			);
		});

		it("creates a new channel when updating from an undefined state", () => {
			collection.update(
				"foo",
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(5) }],
				}),
			);
			assert.deepEqual(collection.getAtOffset(0, "foo"), opKey(5));
		});

		it("overrides earlier calls with later ones", () => {
			collection.update(
				"foo",
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(3) }],
				}),
			);
			collection.update(
				"foo",
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(5) }],
				}),
			);
			assert.deepEqual(collection.getAtOffset(0, "foo"), opKey(5));
		});

		it("can update the root channel", () => {
			collection.update(
				undefined,
				new AttributionCollection({
					type: "entries",
					length: 2,
					rootEntries: [{ offset: 0, key: opKey(3) }],
				}),
			);
			assert.deepEqual(collection.getAtOffset(0), opKey(3));
		});

		it("doesn't tolerate updates to channels having inconsistent length fields", () => {
			assert.throws(() =>
				collection.update(
					"foo",
					new AttributionCollection({
						type: "entries",
						length: 3,
						rootEntries: [{ offset: 0, key: null }],
					}),
				),
			);
		});
	});

	describe("serialized structure is independent of segment lengths", () => {
		interface State {
			random: IRandom;
			segments: ISegment[];
		}

		interface InsertAction {
			type: "insert";
			collection: AttributionCollection;
		}

		interface SplitAction {
			type: "split";
			segIndex: number;
			offset: number;
		}

		interface AppendAction {
			type: "append";
			segIndex: number;
		}

		class Segment extends BaseSegment {
			public readonly type = "testSeg";
			public constructor(length: number) {
				super();
				this.cachedLength = length;
			}

			public toJSONObject(): {
				length: number;
				props: PropertySet | undefined;
			} {
				return { length: this.cachedLength, props: this.properties };
			}

			public clone(): ISegment {
				const seg = new Segment(this.cachedLength);
				this.cloneInto(seg);
				return seg;
			}

			protected createSplitSegmentAt(pos: number): BaseSegment | undefined {
				if (pos > 0) {
					const leafSegment = new Segment(this.cachedLength - pos);
					this.cachedLength = pos;
					return leafSegment;
				}
			}
		}

		for (let seed = 0; seed < 10; seed++) {
			const segmentCount = 100;
			it(`with randomly generated segments, seed ${seed}`, () => {
				const generateAttributionKey = (random: IRandom): AttributionKey | null =>
					random.bool(0.8) ? opKey(random.integer(0, 10)) : random.bool() ? detachedKey : null;

				const channelNamePool = ["ch1", "ch2", "ch3"];
				const insertGenerator: Generator<InsertAction, State> = take(
					segmentCount,
					({ random }) => {
						const length = random.integer(1, 20);
						const collection = new AttributionCollection({
							type: "entries",
							length,
							rootEntries: [{ offset: 0, key: generateAttributionKey(random) }],
						});
						if (random.bool(0.25)) {
							for (const channel of channelNamePool) {
								if (random.bool()) {
									collection.update(
										channel,
										new AttributionCollection({
											type: "entries",
											length,
											rootEntries: [{ offset: 0, key: generateAttributionKey(random) }],
										}),
									);
								}
							}
						}
						return {
							type: "insert",
							collection,
						};
					},
				);

				const initialState = performFuzzActions<InsertAction, State>(
					insertGenerator,
					{
						insert: (state, { collection }) => {
							const { segments } = state;
							const seg = new Segment(collection.length);
							seg.attribution = collection;
							segments.push(seg);
							return state;
						},
					},
					{ random: makeRandom(seed), segments: [] },
				);

				const expected = AttributionCollection.serializeAttributionCollections(
					initialState.segments,
				);

				const split: Generator<SplitAction, State> = ({ segments, random }) => {
					const validIndices = segments
						.map((seg, i) => (seg.cachedLength > 1 ? i : -1))
						.filter((i) => i >= 0);

					const segIndex = random.pick(validIndices);
					const offset = random.integer(1, segments[segIndex].cachedLength - 1);
					return {
						type: "split",
						segIndex,
						offset,
					};
				};
				const append: Generator<AppendAction, State> = ({ random, segments }) => {
					return {
						type: "append",
						segIndex: random.integer(0, segments.length - 2),
					};
				};
				const finalState = performFuzzActions<SplitAction | AppendAction, State>(
					take(
						segmentCount,
						// Note: if playing around with constants in this test, it may be necessary to
						// introduce acceptance criteria here for split.
						createWeightedGenerator<SplitAction | AppendAction, State>([
							[split, 1],
							[append, 1, ({ segments }): boolean => segments.length > 1],
						]),
					),
					{
						split: (state, { segIndex, offset }) => {
							const { segments } = state;
							const splitSeg = segments[segIndex].splitAt(offset);
							assert(splitSeg !== undefined);
							segments.splice(segIndex + 1, 0, splitSeg);
							return state;
						},
						append: (state, { segIndex }) => {
							const { segments } = state;
							segments[segIndex].append(segments[segIndex + 1]);
							segments.splice(segIndex + 1, 1);
							return state;
						},
					},
					initialState,
				);

				assert.deepEqual(
					AttributionCollection.serializeAttributionCollections(finalState.segments),
					expected,
				);
			});
		}
	});
});
