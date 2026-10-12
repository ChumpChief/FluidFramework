/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { AttachState } from "@fluidframework/container-definitions";
import type { IChannelServices } from "@fluidframework/datastore-definitions/internal";
import { readAndParse } from "@fluidframework/driver-utils/internal";
import type { IRuntimeMessageCollection } from "@fluidframework/runtime-definitions/internal";
import { isFluidHandle, toFluidHandleInternal } from "@fluidframework/runtime-utils/internal";
import {
	MockDeltaConnection,
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

/**
 * A test DDS with array snapshots, different operation tags, and a distinct application view.
 */
class TestLog implements ReplicatedDataStructure {
	private readonly entries: unknown[];
	private readonly pending: LogOperation[] = [];
	private readonly retainedForUndo: unknown[] = [];
	private submit: ((content: unknown) => void) | undefined;

	public readonly view: LogView = {
		append: (item) => this.applyLocal({ action: "append", item }),
		read: () => [...this.entries, ...this.pending.map((operation) => operation.item)],
	};

	public constructor(entries: readonly unknown[]) {
		this.entries = [...entries];
	}

	public startReplication(submit: (content: unknown) => void): void {
		assert.equal(this.submit, undefined);
		this.submit = submit;
	}

	public receive(content: unknown, local: boolean): void {
		const operation = parseLogOperation(content);
		if (local) {
			assert(this.pending.shift() !== undefined);
		}
		this.entries.push(operation.item);
	}

	public resubmit(content: unknown): void {
		assert(this.submit !== undefined);
		this.submit(parseLogOperation(content));
	}

	public replay(content: unknown): void {
		this.applyLocal(parseLogOperation(content));
	}

	public rollback(content: unknown): void {
		const operation = parseLogOperation(content);
		assert(this.pending.pop() !== undefined);
		this.retainedForUndo.push(operation.item);
	}

	public getSnapshot(): unknown {
		return [...this.entries];
	}

	public getReferenceData(): unknown {
		return {
			entries: this.entries,
			pending: this.pending,
			undo: this.retainedForUndo,
		};
	}

	private applyLocal(operation: LogOperation): void {
		if (this.submit === undefined) {
			this.entries.push(operation.item);
		} else {
			this.pending.push(operation);
			this.submit(operation);
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

function messages(contents: readonly unknown[], local: boolean): IRuntimeMessageCollection {
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
		firstServices.delta.processMessages(messages(firstServices.submitted, true));
		secondServices.delta.processMessages(messages(firstServices.submitted, false));
		assert.deepEqual(first.entryPoint.read(), ["one", "two"]);
		assert.deepEqual(second.entryPoint.read(), ["one", "two"]);
		assert.deepEqual(first.dds.getSnapshot(), ["one", "two"]);
	});

	it("replays detached edits, resubmits pending edits, and forwards decoded rollback contents", () => {
		const runtime = new MockFluidDataStoreRuntime({ attachState: AttachState.Detached });
		const channel = new DdsChannel("log", runtime, attributes, definition);
		const { services, delta, submitted } = createServices();
		channel.connect(services);
		delta.applyStashedOp({ action: "append", item: "detached" });
		assert.deepEqual(channel.dds.getSnapshot(), ["detached"]);
		assert.deepEqual(submitted, []);
		runtime.setAttachState(AttachState.Attached);
		delta.applyStashedOp({ action: "append", item: "pending" });
		const [pending] = submitted;
		assert(pending !== undefined);
		delta.reSubmit(pending, undefined, false);
		assert.deepEqual(submitted, [pending, pending]);
		assert.deepEqual(channel.entryPoint.read(), ["detached", "pending"]);
		assert.deepEqual(channel.dds.getSnapshot(), ["detached"]);

		const target = new DdsChannel("target", runtime, attributes, definition);
		channel.entryPoint.append({ nested: [target.handle] });
		const operation = submitted.at(-1);
		assert(operation !== undefined);
		delta.rollback?.(operation, undefined);
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
