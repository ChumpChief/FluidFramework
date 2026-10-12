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
import type { ISummaryTree } from "@fluidframework/driver-definitions";
import { buildSnapshotTree } from "@fluidframework/driver-utils/internal";
import type {
	IFluidDataStoreContext,
	IRuntimeMessageCollection,
} from "@fluidframework/runtime-definitions/internal";
import {
	convertSummaryTreeToITree,
	isFluidHandle,
	toFluidHandleInternal,
} from "@fluidframework/runtime-utils/internal";
import { FluidSerializer, SharedObject } from "@fluidframework/shared-object-base/internal";
import {
	MockContainerRuntimeFactoryForReconnection,
	MockDeltaConnection,
	MockFluidDataStoreContext,
	MockFluidDataStoreRuntime,
	MockSharedObjectServices,
	MockStorage,
} from "@fluidframework/test-runtime-utils/internal";

import { CellFactory } from "../cellFactory.js";
import { SharedCell as SharedCellClass } from "../cell.js";
import { SimpleCell } from "../simpleCell.js";
import { SimpleCellChannel } from "../simpleCellChannel.js";
import { createSimpleCell, SimpleCellFactory } from "../simpleCellFactory.js";

const factory = new SimpleCellFactory();
const legacyFactory = new CellFactory();

function messages(contents: readonly unknown[], local = false): IRuntimeMessageCollection {
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
			localOpMetadata: undefined,
			clientSequenceNumber: index + 1,
		})),
	};
}

function createServices(): {
	services: IChannelServices;
	delta: MockDeltaConnection;
	submitted: unknown[];
} {
	const submitted: unknown[] = [];
	const delta = new MockDeltaConnection(
		(content: unknown, metadata) => {
			assert.equal(metadata, undefined);
			return submitted.push(content);
		},
		() => {},
	);
	return {
		services: { deltaConnection: delta, objectStorage: new MockStorage() },
		delta,
		submitted,
	};
}

function createConnected(runtimeFactory: MockContainerRuntimeFactoryForReconnection): {
	channel: SimpleCellChannel;
	runtime: MockFluidDataStoreRuntime;
	containerRuntime: ReturnType<
		MockContainerRuntimeFactoryForReconnection["createContainerRuntime"]
	>;
} {
	const runtime = new MockFluidDataStoreRuntime();
	const containerRuntime = runtimeFactory.createContainerRuntime(runtime);
	const channel = factory.create(runtime, "cell");
	channel.connect({
		deltaConnection: runtime.createDeltaConnection(),
		objectStorage: new MockStorage(),
	});
	return { channel, runtime, containerRuntime };
}

function createDataStore(
	attachState = AttachState.Attached,
	snapshot?: ISummaryTree,
): {
	runtime: FluidDataStoreRuntime;
	submitted: { type: string; content: unknown; metadata: unknown }[];
} {
	const context = new MockFluidDataStoreContext("store");
	context.attachState = attachState;
	context.makeLocallyVisible = () => {};
	context.addedGCOutboundRoute = () => {};
	if (snapshot !== undefined) {
		const blobs = new Map<string, ArrayBufferLike>();
		context.baseSnapshot = buildSnapshotTree(
			convertSummaryTreeToITree(snapshot).entries,
			blobs,
		);
		context.storage = {
			readBlob: async (id) => {
				const blob = blobs.get(id);
				assert(blob !== undefined);
				return blob;
			},
		};
	}
	const submitted: { type: string; content: unknown; metadata: unknown }[] = [];
	const runtimeContext: IFluidDataStoreContext = context;
	runtimeContext.submitMessage = (type, content, metadata) => {
		submitted.push({ type, content, metadata });
	};
	context.IFluidHandleContext = {
		absolutePath: "",
		isAttached: attachState !== AttachState.Detached,
		get IFluidHandleContext() {
			return this;
		},
		attachGraph: () => {},
		resolveHandle: async (request) => {
			assert(request.url.startsWith("/store/"));
			return runtime.resolveHandle({ ...request, url: request.url.slice("/store".length) });
		},
	};
	const runtime = new FluidDataStoreRuntime(
		context,
		new Map<string, IChannelFactory>([
			[factory.type, factory],
			[legacyFactory.type, legacyFactory],
		]),
		attachState !== AttachState.Detached,
		async (dataStore) => dataStore,
	);
	return { runtime, submitted };
}

async function createLoadedDataStore(): Promise<
	ReturnType<typeof createDataStore> & { channel: SimpleCellChannel }
> {
	const source = createDataStore(AttachState.Detached);
	const original = source.runtime.createChannel("cell", factory.type);
	toFluidHandleInternal(original.handle).attachGraph();
	const result = createDataStore(
		AttachState.Attached,
		source.runtime.getAttachSummary().summary,
	);
	const channel = await result.runtime.getChannel("cell");
	assert(channel instanceof SimpleCellChannel);
	return { ...result, channel };
}

describe("SimpleCellChannel", () => {
	describe("lifecycle and snapshots", () => {
		it("composes a Cell without inheriting SharedObject or merging APIs", async () => {
			const runtime = new MockFluidDataStoreRuntime({ registry: [factory] });
			const channel = runtime.createChannel("cell", factory.type);
			assert(channel instanceof SimpleCellChannel);
			assert(!(channel instanceof SharedObject));
			assert(!("set" in channel));
			assert(!("handle" in channel.cell));
			assert(!("IFluidLoadable" in channel.cell));
			assert.equal(channel.IFluidLoadable, channel);
			assert.equal(channel.entryPoint, channel.cell);
			assert.equal(await channel.handle.get(), channel.cell);
			assert.notEqual(factory.type, CellFactory.Type);
		});

		it("keeps an unbound channel local even in an attached runtime", () => {
			const channel = factory.create(new MockFluidDataStoreRuntime(), "cell");
			channel.cell.set(1);
			assert(!channel.isAttached());
			assert(!channel.handle.isAttached);
			assert.deepEqual(channel.cell.getSnapshot(), { value: 1 });
			assert.deepEqual(channel.cell.getPendingOperations(), []);
		});

		it("starts replication on attachment, not on connection to detached services", () => {
			const runtime = new MockFluidDataStoreRuntime({ attachState: AttachState.Detached });
			const channel = factory.create(runtime, "cell");
			const { services, submitted, delta } = createServices();
			channel.connect(services);
			channel.cell.set(1);
			assert.deepEqual(submitted, []);
			assert(!channel.isAttached());
			runtime.setAttachState(AttachState.Attaching);
			assert(channel.isAttached());
			channel.cell.set(2);
			runtime.setAttachState(AttachState.Attached);
			channel.connect(services);
			assert.deepEqual(submitted, [{ type: "set", value: 2 }]);
			delta.processMessages(messages(submitted, true));
			assert.deepEqual(channel.cell.getSnapshot(), { value: 2 });
			assert.deepEqual(channel.cell.getPendingOperations(), []);
		});

		it("loads populated and empty snapshots before connecting", async () => {
			for (const value of [undefined, 42]) {
				const channel = factory.create(new MockFluidDataStoreRuntime(), "cell");
				channel.cell.set(value);
				const summary = await channel.summarize();
				const services = MockSharedObjectServices.createFromSummary(summary.summary);
				const loaded = await factory.load(
					new MockFluidDataStoreRuntime(),
					"loaded",
					services,
					factory.attributes,
				);
				assert.equal(loaded.cell.get(), value);
				assert(loaded.isAttached());
				assert.equal(summary.stats.blobNodeCount, 1);
			}
		});

		it("loads a detached snapshot and incorporates local edits into attachment state", async () => {
			const source = factory.create(new MockFluidDataStoreRuntime(), "cell");
			source.cell.set(1);
			const { services, submitted, delta } = createServices();
			services.objectStorage = MockStorage.createFromSummary(
				source.getAttachSummary().summary,
			);
			const runtime = new MockFluidDataStoreRuntime({ attachState: AttachState.Detached });
			const loaded = await factory.load(runtime, "cell", services, factory.attributes);
			delta.applyStashedOp({ type: "set", value: 2 });
			assert.deepEqual(loaded.cell.getSnapshot(), { value: 2 });
			assert.deepEqual(submitted, []);
			runtime.setAttachState(AttachState.Attached);
			loaded.cell.delete();
			assert.deepEqual(submitted, [{ type: "delete" }]);
		});

		it("summarizes sequenced state rather than unacknowledged local edits", async () => {
			const channel = factory.create(new MockFluidDataStoreRuntime(), "cell");
			channel.cell.set(1);
			const { services } = createServices();
			channel.connect(services);
			channel.cell.set(2);
			const summary = await channel.summarize();
			const loaded = await factory.load(
				new MockFluidDataStoreRuntime(),
				"loaded",
				MockSharedObjectServices.createFromSummary(summary.summary),
				factory.attributes,
			);
			assert.equal(channel.cell.get(), 2);
			assert.equal(loaded.cell.get(), 1);
		});

		it("rejects unsupported formats and malformed snapshots", async () => {
			const services = new MockSharedObjectServices({ header: "[]" });
			await assert.rejects(
				factory.load(new MockFluidDataStoreRuntime(), "cell", services, factory.attributes),
				/snapshot must be an object/,
			);
			for (const attributes of [
				{ ...factory.attributes, type: CellFactory.Type },
				{ ...factory.attributes, snapshotFormatVersion: "future" },
			]) {
				await assert.rejects(
					factory.load(new MockFluidDataStoreRuntime(), "cell", services, attributes),
					/Unsupported SimpleCell channel/,
				);
			}
		});

		it("stops runtime interaction on disposal and removes the attachment listener", () => {
			const runtime = new MockFluidDataStoreRuntime();
			const channel = factory.create(runtime, "cell");
			const { services, delta } = createServices();
			channel.connect(services);
			runtime.dispose();
			assert.equal(runtime.listenerCount("attaching"), 0);
			assert.throws(() => channel.cell.set(1), /runtime is disposed/);
			assert.throws(() => channel.getAttachSummary(), /runtime is disposed/);
			assert.throws(() => channel.getGCData(), /runtime is disposed/);
			assert.throws(() => delta.processMessages(messages([{ type: "delete" }])), /disposed/);
			assert.throws(() => channel.cell.set(2), /SimpleCell is faulted/);
		});
	});

	describe("messages and pending state", () => {
		it("converges under concurrent edits and does not reemit acknowledged edits", () => {
			const runtimeFactory = new MockContainerRuntimeFactoryForReconnection();
			const first = createConnected(runtimeFactory).channel;
			const second = createConnected(runtimeFactory).channel;
			const events: unknown[] = [];
			second.cell.events.on("valueChanged", (value) => events.push(value));
			second.cell.events.on("delete", () => events.push("delete"));
			first.cell.set(1);
			second.cell.set(2);
			second.cell.delete();
			runtimeFactory.processAllMessages();
			assert(first.cell.empty());
			assert(second.cell.empty());
			assert.deepEqual(events, [2, "delete"]);
			assert.deepEqual(first.cell.getPendingOperations(), []);
			assert.deepEqual(second.cell.getPendingOperations(), []);
		});

		it("applies every operation in a runtime message collection", () => {
			const channel = factory.create(new MockFluidDataStoreRuntime(), "cell");
			const { services, delta } = createServices();
			channel.connect(services);
			const events: unknown[] = [];
			channel.cell.events.on("valueChanged", (value) => events.push(value));
			channel.cell.events.on("delete", () => events.push("delete"));
			delta.processMessages(
				messages([{ type: "set", value: 1 }, { type: "delete" }, { type: "set" }]),
			);
			assert.deepEqual(events, [1, "delete", undefined]);
			assert(channel.cell.empty());
		});

		it("resubmits multiple unacknowledged edits and edits made while disconnected", () => {
			const runtimeFactory = new MockContainerRuntimeFactoryForReconnection();
			const first = createConnected(runtimeFactory);
			const second = createConnected(runtimeFactory);
			first.channel.cell.set(1);
			first.containerRuntime.connected = false;
			first.channel.cell.delete();
			first.channel.cell.set(3);
			second.channel.cell.set(2);
			runtimeFactory.processAllMessages();
			first.containerRuntime.connected = true;
			runtimeFactory.processAllMessages();
			assert.equal(first.channel.cell.get(), 3);
			assert.equal(second.channel.cell.get(), 3);
			assert.deepEqual(first.channel.cell.getPendingOperations(), []);
		});

		it("rolls back in reverse order and then accepts remote edits", () => {
			const channel = factory.create(new MockFluidDataStoreRuntime(), "cell");
			const { services, delta, submitted } = createServices();
			channel.connect(services);
			channel.cell.set(1);
			channel.cell.delete();
			const last = submitted.pop();
			delta.rollback?.(last, undefined);
			assert.equal(channel.cell.get(), 1);
			delta.rollback?.(submitted.pop(), undefined);
			assert(channel.cell.empty());
			delta.processMessages(messages([{ type: "set", value: 2 }]));
			assert.equal(channel.cell.get(), 2);
		});

		it("fails explicitly for squashed resubmission and invalid operations", () => {
			const channel = factory.create(new MockFluidDataStoreRuntime(), "cell");
			const { services, delta } = createServices();
			channel.connect(services);
			channel.cell.set(1);
			assert.throws(
				() => delta.reSubmit({ type: "set", value: 1 }, undefined, true),
				/does not support squashed resubmission/,
			);
			assert.throws(
				() => delta.processMessages(messages([{ type: "unknown" }])),
				/Unsupported SimpleCell operation/,
			);
			assert.throws(() => delta.applyStashedOp(1), /operation must be an object/);
		});
	});

	describe("handles and garbage collection", () => {
		it("binds nested handles during attach summary and avoids binding during GC", () => {
			const targetRuntime = new MockFluidDataStoreRuntime();
			let binds = 0;
			targetRuntime.bindChannel = () => {
				binds++;
			};
			const child = factory.create(targetRuntime, "child");
			const parent = factory.create(new MockFluidDataStoreRuntime(), "parent");
			parent.cell.set({ nested: [child.handle, child.handle] });
			assert.deepEqual(parent.getGCData(), { gcNodes: { "/": [child.handle.absolutePath] } });
			assert.equal(binds, 0);
			parent.getAttachSummary();
			assert.equal(binds, 0);
			parent.handle.attachGraph();
			assert.equal(binds, 1);
			assert(child.isAttached());
		});

		it("collects sequenced and pending references and releases them after acknowledgment", () => {
			const runtime = new MockFluidDataStoreRuntime();
			const child = factory.create(runtime, "child");
			const pendingChild = factory.create(runtime, "pending");
			const parent = factory.create(runtime, "parent");
			parent.cell.set(child.handle);
			const { services, delta, submitted } = createServices();
			parent.connect(services);
			parent.cell.set({ nested: [pendingChild.handle] });
			assert.deepEqual(parent.getGCData(), {
				gcNodes: { "/": [child.handle.absolutePath, pendingChild.handle.absolutePath] },
			});
			assert(pendingChild.isAttached());
			delta.processMessages(messages(submitted.splice(0), true));
			assert.deepEqual(parent.getGCData(), {
				gcNodes: { "/": [pendingChild.handle.absolutePath] },
			});
			parent.cell.delete();
			delta.processMessages(messages(submitted.splice(0), true));
			assert.deepEqual(parent.getGCData(), { gcNodes: { "/": [] } });
		});

		it("acknowledges encoded local operations without replacing the original value or reemitting events", () => {
			const runtime = new MockFluidDataStoreRuntime();
			const child = factory.create(runtime, "child");
			const parent = factory.create(runtime, "parent");
			const { services, delta, submitted } = createServices();
			parent.connect(services);
			const events: unknown[] = [];
			parent.cell.events.on("valueChanged", (value) => events.push(value));
			parent.cell.set(child.handle);
			delta.processMessages(messages(submitted, true));
			assert.equal(parent.cell.get(), child.handle);
			assert.equal(parent.cell.getSnapshot().value, child.handle);
			assert.deepEqual(parent.cell.getPendingOperations(), []);
			assert.deepEqual(events, [child.handle]);
		});

		it("round-trips nested handles through summaries, operations, and reconnection", async () => {
			const runtimeFactory = new MockContainerRuntimeFactoryForReconnection();
			const first = createConnected(runtimeFactory);
			const second = createConnected(runtimeFactory);
			const child = factory.create(first.runtime, "child");
			first.channel.cell.set({ nested: [child.handle] });
			first.containerRuntime.connected = false;
			first.containerRuntime.connected = true;
			runtimeFactory.processAllMessages();
			const expected = { gcNodes: { "/": [child.handle.absolutePath] } };
			assert.deepEqual(second.channel.getGCData(), expected);
			const loaded = await factory.load(
				second.runtime,
				"loaded",
				MockSharedObjectServices.createFromSummary(second.channel.getAttachSummary().summary),
				factory.attributes,
			);
			assert.deepEqual(loaded.getGCData(), expected);
		});

		it("binds handles without encoding when the runtime owns handle encoding", () => {
			const runtime = Object.assign(new MockFluidDataStoreRuntime(), {
				submitMessagesWithoutEncodingHandles: true,
			});
			const parent = factory.create(runtime, "parent");
			const child = factory.create(runtime, "child");
			const { services, submitted } = createServices();
			parent.connect(services);
			parent.cell.set(child.handle);
			assert.deepEqual(submitted, [{ type: "set", value: child.handle }]);
			assert(child.isAttached());
		});

		it("does not attach discarded handles while staging", () => {
			const runtime = new MockFluidDataStoreRuntime({ inStagingMode: true });
			let binds = 0;
			runtime.bindChannel = () => {
				binds++;
			};
			const parent = factory.create(runtime, "parent");
			const child = factory.create(runtime, "child");
			const { services, delta, submitted } = createServices();
			parent.connect(services);
			parent.cell.set(child.handle);
			assert.equal(binds, 0);
			assert(!child.isAttached());
			delta.rollback?.(submitted.pop(), undefined);
			assert(parent.cell.empty());
			assert.deepEqual(parent.getGCData(), { gcNodes: { "/": [] } });
		});
	});

	describe("data store integration", () => {
		it("registers and attaches channels through the real data store runtime", async () => {
			const { runtime, submitted } = createDataStore();
			const channel = runtime.createChannel("cell", factory.type);
			assert(channel instanceof SimpleCellChannel);
			channel.cell.set(1);
			channel.handle.attachGraph();
			assert(channel.isAttached());
			assert.equal(await runtime.getChannel("cell"), channel);
			assert.equal(submitted[0]?.type, "attach");
			channel.cell.set(2);
			assert.deepEqual(submitted[1], {
				type: "op",
				content: { address: "cell", contents: { type: "set", value: 2 } },
				metadata: undefined,
			});
		});

		it("binds channels before a detached data store attaches", () => {
			const { runtime, submitted } = createDataStore(AttachState.Detached);
			const channel = runtime.createChannel("cell", factory.type);
			assert(channel instanceof SimpleCellChannel);
			channel.cell.set(1);
			channel.handle.attachGraph();
			assert(!channel.isAttached());
			const summary = runtime.getAttachSummary();
			assert("cell" in summary.summary.tree);
			runtime.setAttachState(AttachState.Attaching);
			runtime.setAttachState(AttachState.Attached);
			channel.cell.set(2);
			assert.equal(submitted.length, 1);
			assert.deepEqual(submitted[0]?.content, {
				address: "cell",
				contents: { type: "set", value: 2 },
			});
		});

		it("resolves serialized handles to Cell entry points without grafting APIs", async () => {
			const { runtime } = createDataStore();
			const parent = runtime.createChannel("parent", factory.type);
			const child = runtime.createChannel("child", factory.type);
			assert(parent instanceof SimpleCellChannel && child instanceof SimpleCellChannel);
			child.cell.set(42);
			parent.cell.set(child.handle);
			parent.handle.attachGraph();
			assert(parent.isAttached() && child.isAttached());
			const services = MockSharedObjectServices.createFromSummary(
				parent.getAttachSummary().summary,
			);
			const loaded = await factory.load(runtime, "loaded", services, factory.attributes);
			const handle = loaded.cell.get();
			assert(isFluidHandle(handle));
			assert.equal(toFluidHandleInternal(handle).absolutePath, child.handle.absolutePath);
			assert.equal(await handle.get(), child.cell);
			assert.equal(await child.handle.get(), child.cell);
			assert.equal(await runtime.getChannel("child"), child);
			assert.equal(child.cell.get(), 42);
		});

		it("creates an app-facing Cell and handle while retaining the adapter in the runtime", async () => {
			const { runtime, submitted } = createDataStore();
			const { value, handle } = createSimpleCell(runtime, "cell");
			const channel = await runtime.getChannel("cell");
			assert(channel instanceof SimpleCellChannel);
			assert.equal(value, channel.entryPoint);
			assert.equal(handle, channel.handle);
			assert.equal(await handle.get(), value);
			assert(!("IFluidLoadable" in value));
			assert(!("handle" in value));
			assert(!("summarize" in value));
			assert(value.empty());
			const events: unknown[] = [];
			const unsubscribe = value.events.on("valueChanged", (next) => events.push(next));
			const unsubscribeDelete = value.events.on("delete", () => events.push("delete"));
			value.set(42);
			assert(!handle.isAttached);
			assert.equal(submitted.length, 0);

			const parent = runtime.createChannel("parent", legacyFactory.type);
			assert(parent instanceof SharedCellClass);
			parent.handle.attachGraph();
			parent.set(handle);
			assert(handle.isAttached);
			const resolved = await handle.get();
			assert.equal(resolved.get(), 42);
			resolved.set(43);
			assert.deepEqual(submitted.at(-1)?.content, {
				address: "cell",
				contents: { type: "set", value: 43 },
			});
			resolved.delete();
			assert(value.empty());
			assert.equal(value.get(), undefined);
			assert.deepEqual(events, [42, 43, "delete"]);
			unsubscribe();
			unsubscribeDelete();
		});

		it("supports creation with runtime-generated identifiers", async () => {
			const { runtime } = createDataStore();
			const first = createSimpleCell(runtime);
			const second = createSimpleCell(runtime);
			assert.notEqual(first.value, second.value);
			assert.notEqual(
				toFluidHandleInternal(first.handle).absolutePath,
				toFluidHandleInternal(second.handle).absolutePath,
			);
			assert.equal(await first.handle.get(), first.value);
			assert.equal(await second.handle.get(), second.value);
		});

		it("resolves a lazily loaded entry point in another runtime and keeps the adapter usable", async () => {
			const source = createDataStore(AttachState.Detached);
			const parent = createSimpleCell(source.runtime, "parent");
			const child = createSimpleCell(source.runtime, "child");
			child.value.set(42);
			parent.value.set(child.handle);
			toFluidHandleInternal(parent.handle).attachGraph();
			const snapshot = source.runtime.getAttachSummary();
			const target = createDataStore(AttachState.Attached, snapshot.summary);
			const loadedParent = await target.runtime.getChannel("parent");
			assert(loadedParent instanceof SimpleCellChannel);
			const remoteHandle = loadedParent.cell.get();
			assert(isFluidHandle(remoteHandle));
			const resolved = await remoteHandle.get();
			assert(resolved instanceof SimpleCell);
			assert.equal(resolved.get(), 42);
			assert.notEqual(resolved, child.value);
			const loadedChild = await target.runtime.getChannel("child");
			assert(loadedChild instanceof SimpleCellChannel);
			assert.equal(resolved, loadedChild.entryPoint);
			assert.equal(resolved, await loadedChild.handle.get());
			assert.equal(resolved, await remoteHandle.get());
			const routed = await target.runtime.resolveHandle({ url: "/_channels/child" });
			assert.equal(routed.status, 200);
			assert.equal(routed.value, resolved);

			resolved.set(43);
			const [submission] = target.submitted;
			assert(submission !== undefined);
			assert.deepEqual(submission.content, {
				address: "child",
				contents: { type: "set", value: 43 },
			});
			target.runtime.processMessages(messages([submission.content], true));
			const nextSnapshot = await target.runtime.summarize(true, false);
			const reloaded = createDataStore(AttachState.Attached, nextSnapshot.summary);
			const latest = await reloaded.runtime.getChannel("child");
			assert(latest instanceof SimpleCellChannel);
			assert.equal(latest.cell.get(), 43);
		});

		it("preserves legacy channel identity for local and serialized handles", async () => {
			const { runtime } = createDataStore();
			const legacy = runtime.createChannel("legacy", legacyFactory.type);
			assert(legacy instanceof SharedCellClass);
			legacy.set(42);
			legacy.handle.attachGraph();
			const serializer = new FluidSerializer(runtime.channelsRoutingContext);
			const remoteHandle = serializer.decode(serializer.encode(legacy.handle, legacy.handle));
			assert(isFluidHandle(remoteHandle));
			assert.equal(await legacy.handle.get(), legacy);
			assert.equal(await remoteHandle.get(), legacy);
			assert.equal(await runtime.getChannel("legacy"), legacy);
			const response = await runtime.resolveHandle({ url: "/legacy" });
			assert.equal(response.status, 200);
			assert.equal(response.value, legacy);
		});

		it("does not silently fall back to the adapter for an invalid entry point", async () => {
			const { runtime } = createDataStore();
			const channel = runtime.createChannel("cell", factory.type);
			Object.defineProperty(channel, "entryPoint", { value: undefined });
			const response = await runtime.resolveHandle({ url: "/cell" });
			assert.equal(response.status, 500);
			assert.notEqual(response.value, channel);
		});

		it("attaches a cycle of channel references without duplicate binding", () => {
			const { runtime, submitted } = createDataStore();
			const first = runtime.createChannel("first", factory.type);
			const second = runtime.createChannel("second", factory.type);
			assert(first instanceof SimpleCellChannel && second instanceof SimpleCellChannel);
			first.cell.set(second.handle);
			second.cell.set(first.handle);
			first.handle.attachGraph();
			assert(first.isAttached() && second.isAttached());
			assert.equal(submitted.length, 2);
			assert(submitted.every((message) => message.type === "attach"));
			assert.deepEqual(first.getGCData(), {
				gcNodes: { "/": [second.handle.absolutePath] },
			});
			assert.deepEqual(second.getGCData(), {
				gcNodes: { "/": [first.handle.absolutePath] },
			});
		});

		it("replays stashed edits through the runtime capture path without double submission", async () => {
			const { runtime, submitted, channel } = await createLoadedDataStore();
			const op = { address: "cell", contents: { type: "set", value: 1 } };
			const metadata = await runtime.applyStashedOp({ type: "op", content: op });
			assert.equal(channel.cell.get(), 1);
			assert.equal(submitted.length, 0);
			const collection = messages([op], true);
			runtime.processMessages({
				...collection,
				messagesContent: collection.messagesContent.map((message) => ({
					...message,
					localOpMetadata: metadata,
				})),
			});
			assert.deepEqual(channel.cell.getPendingOperations(), []);
			assert.deepEqual(channel.cell.getSnapshot(), { value: 1 });
		});

		it("resubmits stashed handle edits using the runtime's captured metadata", async () => {
			const { runtime, submitted, channel } = await createLoadedDataStore();
			const child = runtime.createChannel("child", factory.type);
			assert(child instanceof SimpleCellChannel);
			const serializer = new FluidSerializer(runtime.channelsRoutingContext);
			const content = {
				address: "cell",
				contents: serializer.encode({ type: "set", value: child.handle }, channel.handle),
			};
			submitted.length = 0;
			const metadata = await runtime.applyStashedOp({ type: "op", content });
			assert.equal(submitted.length, 0);
			runtime.reSubmit(DataStoreMessageType.ChannelOp, content, metadata, false);
			assert.equal(submitted.length, 1);
			assert.deepEqual(submitted[0]?.content, content);
			assert.equal(channel.cell.getPendingOperations().length, 1);
			runtime.processMessages(messages([content], true));
			assert.deepEqual(channel.cell.getPendingOperations(), []);
			assert(isFluidHandle(channel.cell.get()));
			assert.deepEqual(channel.getGCData(), {
				gcNodes: { "/": [child.handle.absolutePath] },
			});
		});

		it("rolls back a replayed edit using the runtime's captured metadata", async () => {
			const { runtime, channel } = await createLoadedDataStore();
			const content = { address: "cell", contents: { type: "set", value: 1 } };
			const metadata = await runtime.applyStashedOp({ type: "op", content });
			assert(runtime.rollback !== undefined);
			runtime.rollback(DataStoreMessageType.ChannelOp, content, metadata);
			assert(channel.cell.empty());
			assert.deepEqual(channel.cell.getPendingOperations(), []);
			runtime.processMessages(
				messages([{ address: "cell", contents: { type: "set", value: 2 } }]),
			);
			assert.equal(channel.cell.get(), 2);
		});
	});
});
