/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { AttachState } from "@fluidframework/container-definitions";
import {
	DataStoreMessageType,
	FluidDataStoreRuntime,
} from "@fluidframework/datastore/internal";
import type {
	IChannelFactory,
	IChannelServices,
} from "@fluidframework/datastore-definitions/internal";
import { SummaryType } from "@fluidframework/driver-definitions";
import { buildSnapshotTree, readAndParse } from "@fluidframework/driver-utils/internal";
import type {
	IFluidDataStoreContext,
	IRuntimeMessageCollection,
} from "@fluidframework/runtime-definitions/internal";
import {
	convertSummaryTreeToITree,
	isFluidHandle,
	toFluidHandleInternal,
} from "@fluidframework/runtime-utils/internal";
import {
	MockDeltaConnection,
	MockFluidDataStoreContext,
	MockFluidDataStoreRuntime,
	MockSharedObjectServices,
	MockStorage,
} from "@fluidframework/test-runtime-utils/internal";

import { DdsChannel } from "../ddsChannel.js";
import type {
	DataStructureDefinition,
	DataStructureInstance,
	ReplicatedDataStructure,
} from "../replicatedDataStructure.js";

interface LogOperation {
	action: "append";
	item: unknown;
}

interface LogView {
	append(item: unknown): void;
	read(): readonly unknown[];
}

interface LogLocalMetadata {
	readonly operation: LogOperation;
}

/**
 * A test DDS with array snapshots, different operation tags, and a distinct application view.
 */
class TestLog implements ReplicatedDataStructure {
	private readonly entries: unknown[];
	private readonly pending: LogLocalMetadata[] = [];
	private readonly retainedForUndo: unknown[] = [];
	private submit: ((content: unknown, localMetadata?: unknown) => void) | undefined;
	public readonly squashRequests: boolean[] = [];

	public readonly view: LogView = {
		append: (item) => this.applyLocal({ action: "append", item }),
		read: () => [...this.entries, ...this.pending.map((metadata) => metadata.operation.item)],
	};

	public constructor(entries: readonly unknown[]) {
		this.entries = [...entries];
	}

	public startReplication(submit: (content: unknown, localMetadata?: unknown) => void): void {
		assert.equal(this.submit, undefined);
		this.submit = submit;
	}

	public receive(content: unknown, local: boolean, localMetadata: unknown): void {
		const operation = parseLogOperation(content);
		if (local) {
			const pending = this.pending.shift();
			assert(pending !== undefined);
			assert.equal(localMetadata, pending);
			this.entries.push(pending.operation.item);
		} else {
			assert.equal(localMetadata, undefined);
			this.entries.push(operation.item);
		}
	}

	public resubmit(content: unknown, localMetadata: unknown, squash: boolean): void {
		assert(this.submit !== undefined);
		const pending = this.pending.find((entry) => entry === localMetadata);
		assert(pending !== undefined);
		this.squashRequests.push(squash);
		this.submit(parseLogOperation(content), pending);
	}

	public replay(content: unknown): void {
		this.applyLocal(parseLogOperation(content));
	}

	public rollback(content: unknown, localMetadata: unknown): void {
		const operation = parseLogOperation(content);
		const pending = this.pending.pop();
		assert(pending !== undefined);
		assert.equal(localMetadata, pending);
		this.retainedForUndo.push(operation.item);
	}

	public getSnapshot(): unknown {
		return [...this.entries];
	}

	public getReferenceData(): unknown {
		return {
			entries: this.entries,
			pending: this.pending.map((metadata) => metadata.operation),
			undo: this.retainedForUndo,
		};
	}

	private applyLocal(operation: LogOperation): void {
		if (this.submit === undefined) {
			this.entries.push(operation.item);
		} else {
			const metadata: LogLocalMetadata = { operation };
			// A cycle catches accidental encoding or decoding of local metadata.
			Object.defineProperty(metadata, "self", { value: metadata, enumerable: true });
			this.pending.push(metadata);
			this.submit(operation, metadata);
		}
	}
}

function parseLogOperation(content: unknown): LogOperation {
	assert(typeof content === "object" && content !== null);
	assert("action" in content && content.action === "append");
	assert("item" in content);
	return { action: "append", item: content.item };
}

function createLog(entries: readonly unknown[]): DataStructureInstance<LogView> {
	const log = new TestLog(entries);
	return { dds: log, value: log.view };
}

const definition: DataStructureDefinition<LogView> = {
	create: () => createLog([]),
	restore: (snapshot) => {
		assert(Array.isArray(snapshot), "Log snapshot must be an array");
		return createLog(snapshot);
	},
};

const attributes = { type: "test-log", snapshotFormatVersion: "1" };

function createServices(): {
	services: IChannelServices;
	delta: MockDeltaConnection;
	submitted: unknown[];
	metadata: unknown[];
} {
	const submitted: unknown[] = [];
	const metadata: unknown[] = [];
	const delta = new MockDeltaConnection(
		(content: unknown, localMetadata) => {
			metadata.push(localMetadata);
			return submitted.push(content);
		},
		() => {},
	);
	return {
		services: { deltaConnection: delta, objectStorage: new MockStorage() },
		delta,
		submitted,
		metadata,
	};
}

function messages(
	contents: readonly unknown[],
	local: boolean,
	metadata: readonly unknown[] = [],
): IRuntimeMessageCollection {
	return {
		envelope: {
			type: "op",
			clientId: "client",
			sequenceNumber: 1,
			referenceSequenceNumber: 0,
			minimumSequenceNumber: 0,
			timestamp: 0,
		},
		local,
		messagesContent: contents.map((content, index) => ({
			contents: content,
			localOpMetadata: local ? metadata[index] : undefined,
			clientSequenceNumber: index + 1,
		})),
	};
}

async function createLoadedLogRuntime(): Promise<{
	runtime: FluidDataStoreRuntime;
	log: TestLog;
	submitted: { content: unknown; metadata: unknown }[];
}> {
	const factory: IChannelFactory<DdsChannel<LogView>> = {
		type: attributes.type,
		attributes,
		create: (host, id) => new DdsChannel(id, host, attributes, definition),
		load: async (host, id, services, loadedAttributes) => {
			const snapshot = await readAndParse<unknown>(services.objectStorage, "header");
			const restored = new DdsChannel(id, host, loadedAttributes, definition, snapshot);
			restored.connect(services);
			return restored;
		},
	};
	const source = factory.create(new MockFluidDataStoreRuntime(), "log");
	const summary = source.getAttachSummary().summary;
	const context = new MockFluidDataStoreContext("store");
	context.attachState = AttachState.Attached;
	const blobs = new Map<string, ArrayBufferLike>();
	context.baseSnapshot = buildSnapshotTree(
		convertSummaryTreeToITree({
			type: SummaryType.Tree,
			tree: {
				log: {
					...summary,
					tree: {
						...summary.tree,
						".attributes": {
							type: SummaryType.Blob,
							content: JSON.stringify(attributes),
						},
					},
				},
			},
		}).entries,
		blobs,
	);
	context.storage = {
		readBlob: async (id) => {
			const blob = blobs.get(id);
			assert(blob !== undefined);
			return blob;
		},
	};
	const submitted: { content: unknown; metadata: unknown }[] = [];
	const runtimeContext: IFluidDataStoreContext = context;
	runtimeContext.submitMessage = (_type, content, metadata) => {
		submitted.push({ content, metadata });
	};
	const runtime = new FluidDataStoreRuntime(
		context,
		new Map<string, IChannelFactory>([[factory.type, factory]]),
		true,
		async (dataStore) => dataStore,
	);
	const channel = await runtime.getChannel("log");
	assert(channel instanceof DdsChannel && channel.dds instanceof TestLog);
	return { runtime, log: channel.dds, submitted };
}

describe("DdsChannel with a different DDS", () => {
	it("uses a supplied definition and exposes a distinct application view", async () => {
		const channel = new DdsChannel(
			"log",
			new MockFluidDataStoreRuntime(),
			attributes,
			definition,
		);
		assert(channel.dds instanceof TestLog);
		assert.notEqual(channel.entryPoint, channel.dds);
		assert(!("receive" in channel.entryPoint));
		assert(!("append" in channel));
		assert.equal(await channel.handle.get(), channel.entryPoint);
		channel.entryPoint.append("first");
		assert.deepEqual(channel.entryPoint.read(), ["first"]);
		assert.deepEqual(channel.dds.getSnapshot(), ["first"]);
	});

	it("delivers remote operations and local acknowledgments without interpreting their fields", () => {
		const first = new DdsChannel(
			"log",
			new MockFluidDataStoreRuntime(),
			attributes,
			definition,
		);
		const second = new DdsChannel(
			"log",
			new MockFluidDataStoreRuntime(),
			attributes,
			definition,
		);
		const firstServices = createServices();
		const secondServices = createServices();
		first.connect(firstServices.services);
		second.connect(secondServices.services);
		first.entryPoint.append("one");
		first.entryPoint.append("two");
		assert.deepEqual(first.dds.getSnapshot(), []);
		firstServices.delta.processMessages(
			messages(firstServices.submitted, true, firstServices.metadata),
		);
		secondServices.delta.processMessages(messages(firstServices.submitted, false));
		assert.deepEqual(first.entryPoint.read(), ["one", "two"]);
		assert.deepEqual(second.entryPoint.read(), ["one", "two"]);
		assert.deepEqual(first.dds.getSnapshot(), ["one", "two"]);
	});

	it("replays detached edits, resubmits pending edits, and forwards decoded rollback contents", () => {
		const runtime = new MockFluidDataStoreRuntime({ attachState: AttachState.Detached });
		const channel = new DdsChannel("log", runtime, attributes, definition);
		const { services, delta, submitted, metadata } = createServices();
		channel.connect(services);
		delta.applyStashedOp({ action: "append", item: "detached" });
		assert.deepEqual(channel.dds.getSnapshot(), ["detached"]);
		assert.deepEqual(submitted, []);
		runtime.setAttachState(AttachState.Attached);
		delta.applyStashedOp({ action: "append", item: "pending" });
		const [pending] = submitted;
		assert(pending !== undefined);
		delta.reSubmit(pending, metadata[0], false);
		assert.deepEqual(submitted, [pending, pending]);
		assert.deepEqual(channel.entryPoint.read(), ["detached", "pending"]);
		assert.deepEqual(channel.dds.getSnapshot(), ["detached"]);

		const target = new DdsChannel("target", runtime, attributes, definition);
		channel.entryPoint.append({ nested: [target.handle] });
		const operation = submitted.at(-1);
		assert(operation !== undefined);
		delta.rollback?.(operation, metadata.at(-1));
		assert.deepEqual(channel.entryPoint.read(), ["detached", "pending"]);
		// The reference only survives in the DDS's undo state, not its snapshot or pending edits.
		assert.deepEqual(channel.getGCData(), { gcNodes: { "/": [target.handle.absolutePath] } });
		const references = channel.dds.getReferenceData();
		assert(typeof references === "object" && references !== null && "undo" in references);
		assert(Array.isArray(references.undo));
		const retained: unknown = references.undo[0];
		assert(typeof retained === "object" && retained !== null && "nested" in retained);
		assert(Array.isArray(retained.nested));
		const handle: unknown = retained.nested[0];
		assert(isFluidHandle(handle), "Rollback must receive decoded handles");
		assert.equal(toFluidHandleInternal(handle).absolutePath, target.handle.absolutePath);
	});

	for (const onlyBind of [false, true]) {
		it(`preserves opaque metadata through squash, acknowledgment, and rollback (onlyBind: ${onlyBind})`, () => {
			const runtime = Object.assign(new MockFluidDataStoreRuntime(), {
				submitMessagesWithoutEncodingHandles: onlyBind,
			});
			const channel = new DdsChannel("log", runtime, attributes, definition);
			const target = new DdsChannel("target", runtime, attributes, definition);
			assert(channel.dds instanceof TestLog);
			const { services, delta, submitted, metadata } = createServices();
			channel.connect(services);
			channel.entryPoint.append({ nested: [target.handle] });
			const original = submitted[0];
			const originalMetadata = metadata[0];
			assert(
				typeof originalMetadata === "object" &&
					originalMetadata !== null &&
					"self" in originalMetadata,
			);
			assert.equal(originalMetadata.self, originalMetadata);
			assert(target.isAttached());
			assert.equal(metadata.length, 1);
			const expected = {
				action: "append",
				item: {
					nested: [
						onlyBind
							? target.handle
							: { type: "__fluid_handle__", url: target.handle.absolutePath },
					],
				},
			};
			assert.deepEqual(original, expected);
			assert(delta.handler !== undefined);
			for (const squash of [undefined, false, true]) {
				delta.handler.reSubmit(original, originalMetadata, squash);
				assert.deepEqual(submitted.at(-1), expected);
				assert.equal(metadata.at(-1), originalMetadata);
			}
			assert.deepEqual(channel.dds.squashRequests, [false, false, true]);
			assert.equal(channel.entryPoint.read().length, 1);
			assert.deepEqual(channel.dds.getSnapshot(), []);
			delta.processMessages(messages([submitted.at(-1)], true, [originalMetadata]));
			assert.deepEqual(channel.dds.getSnapshot(), [{ nested: [target.handle] }]);
			assert.equal(channel.entryPoint.read().length, 1);
			assert.deepEqual(channel.getGCData(), {
				gcNodes: { "/": [target.handle.absolutePath] },
			});
			channel.entryPoint.append("rollback");
			delta.rollback?.(submitted.at(-1), metadata.at(-1));
			assert.equal(channel.entryPoint.read().length, 1);
		});
	}

	for (const action of ["acknowledge", "resubmit", "rollback"] as const) {
		it(`reconstructs local metadata during stashed replay for ${action}`, async () => {
			const { runtime, log, submitted } = await createLoadedLogRuntime();
			const content = { address: "log", contents: { action: "append", item: "replayed" } };
			const capturedMetadata = await runtime.applyStashedOp({ type: "op", content });
			assert.deepEqual(log.view.read(), ["replayed"]);
			assert.deepEqual(log.getSnapshot(), []);
			assert.equal(submitted.length, 0);
			if (action === "rollback") {
				assert(runtime.rollback !== undefined);
				runtime.rollback(DataStoreMessageType.ChannelOp, content, capturedMetadata);
				assert.deepEqual(log.view.read(), []);
				assert.deepEqual(log.getSnapshot(), []);
			} else {
				let metadata = capturedMetadata;
				if (action === "resubmit") {
					runtime.reSubmit(DataStoreMessageType.ChannelOp, content, capturedMetadata, true);
					assert.deepEqual(log.squashRequests, [true]);
					assert.equal(submitted.length, 1);
					const submission = submitted[0];
					assert(submission !== undefined);
					assert.deepEqual(submission.content, content);
					metadata = submission.metadata;
				}
				runtime.processMessages(messages([content], true, [metadata]));
				assert.deepEqual(log.view.read(), ["replayed"]);
				assert.deepEqual(log.getSnapshot(), ["replayed"]);
			}
		});
	}

	it("decodes array snapshots before invoking the DDS restoration function", async () => {
		const sourceRuntime = new MockFluidDataStoreRuntime();
		const source = new DdsChannel("log", sourceRuntime, attributes, definition);
		const target = new DdsChannel("target", sourceRuntime, attributes, definition);
		source.entryPoint.append({ nested: [target.handle] });
		const summary = source.getAttachSummary();
		assert(
			!target.isAttached(),
			"GC and snapshot construction must not attach an unbound target",
		);
		const snapshotServices = MockSharedObjectServices.createFromSummary(summary.summary);
		const encodedSnapshot = await readAndParse<unknown>(
			snapshotServices.objectStorage,
			"header",
		);
		const restored = new DdsChannel(
			"log",
			new MockFluidDataStoreRuntime(),
			attributes,
			definition,
			encodedSnapshot,
		);
		const [entry] = restored.entryPoint.read();
		assert(typeof entry === "object" && entry !== null && "nested" in entry);
		assert(Array.isArray(entry.nested));
		const handle: unknown = entry.nested[0];
		assert(isFluidHandle(handle), "Restoration must receive decoded handles");
		assert.deepEqual(restored.getGCData(), { gcNodes: { "/": [target.handle.absolutePath] } });
		assert.equal(await restored.handle.get(), restored.entryPoint);
		assert.throws(
			() => new DdsChannel("log", sourceRuntime, attributes, definition, { value: 1 }),
			/Log snapshot must be an array/,
		);
	});
});
