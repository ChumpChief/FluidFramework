/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	IsoBuffer,
	TypedEventEmitter,
	bufferToString,
	createEmitter,
	gitHashFile,
} from "@fluid-internal/client-utils";
import {
	AttachState,
	type IContainerStorageService,
} from "@fluidframework/container-definitions/internal";
import { IContainerRuntimeEvents } from "@fluidframework/container-runtime-definitions/internal";
import {
	type IFluidHandle,
	type IFluidHandleContext,
	type ITelemetryBaseLogger,
} from "@fluidframework/core-interfaces/internal";
import { SummaryType } from "@fluidframework/driver-definitions";
import type { ISequencedMessageEnvelope } from "@fluidframework/runtime-definitions/internal";
import {
	isFluidHandleInternalPayloadPending,
	isFluidHandlePayloadPending,
	toFluidHandleInternal,
} from "@fluidframework/runtime-utils/internal";
import { MockLogger } from "@fluidframework/telemetry-utils/internal";
import { v4 as uuid } from "uuid";

import {
	BlobManager,
	type IBlobManagerRuntime,
	redirectTableBlobName,
} from "../blobManager/index.js";

const MIN_TTL = 24 * 60 * 60; // same as ODSP

interface MockBlobStorageInternalEvents {
	blobCreated: (id: string) => void;
}

class MockBlobStorage implements Pick<IContainerStorageService, "createBlob" | "readBlob"> {
	public minTTL: number = MIN_TTL;

	public readonly blobs: Map<string, ArrayBufferLike> = new Map();
	public readonly unprocessedBlobs: [string, ArrayBufferLike][] = [];

	private readonly internalEvents = createEmitter<MockBlobStorageInternalEvents>();

	public constructor(private readonly dedupe: boolean) {}

	private _paused: boolean = false;
	public pause = () => {
		this._paused = true;
	};

	public unpause = () => {
		this._paused = false;
		this.processAll();
	};

	public readonly createBlob = async (blob: ArrayBufferLike) => {
		let id: string;
		if (this.dedupe) {
			const s = bufferToString(blob, "base64");
			id = await gitHashFile(IsoBuffer.from(s, "base64"));
		} else {
			id = this.blobs.size.toString();
		}
		this.unprocessedBlobs.push([id, blob]);

		const blobCreatedP = new Promise<void>((resolve) => {
			const onBlobCreated = (_id: string) => {
				if (_id === id) {
					this.internalEvents.off("blobCreated", onBlobCreated);
					resolve();
				}
			};
			this.internalEvents.on("blobCreated", onBlobCreated);
		});

		if (!this._paused) {
			this.processAll();
		}

		await blobCreatedP;

		return { id, minTTLInSeconds: this.minTTL };
	};

	public readonly readBlob = async (id: string) => {
		const blob = this.blobs.get(id);
		assert(blob !== undefined, `Couldn't find blob ${id}`);
		return blob;
	};

	// TODO: minTTL override param?
	public readonly processOne = () => {
		const next = this.unprocessedBlobs.shift();
		assert(next !== undefined, "Tried processing, but none to process");

		const [id, blob] = next;
		this.blobs.set(id, blob);
		this.internalEvents.emit("blobCreated", id);
	};

	public readonly processAll = () => {
		while (this.unprocessedBlobs.length > 0) {
			this.processOne();
		}
	};
}

class MockStorageAdapter implements Pick<IContainerStorageService, "createBlob" | "readBlob"> {
	public readonly detachedStorage = new MockBlobStorage(false);
	public readonly attachedStorage = new MockBlobStorage(true);
	public readonly pause = () => {
		this.getCurrentStorage().pause();
	};
	public readonly unpause = () => {
		this.getCurrentStorage().unpause();
	};
	private attached = false;
	public readonly simulateAttach = async (
		setRedirectTable: BlobManager["setRedirectTable"],
	) => {
		assert(!this.attached, "Can't simulate attach twice");
		// At least under current patterns, detached storage should always process blobs immediately.
		assert(
			this.detachedStorage.unprocessedBlobs.length === 0,
			"Detached storage has unprocessed blobs",
		);
		const detachedToAttachedMappings = await Promise.all(
			[...this.detachedStorage.blobs].map(async ([detachedStorageId, blob]) => {
				return this.attachedStorage.createBlob(blob).then(({ id: attachedStorageId }) => {
					return [detachedStorageId, attachedStorageId] as const;
				});
			}),
		);
		const redirectTable = new Map(detachedToAttachedMappings);
		setRedirectTable(redirectTable);

		this.attached = true;
	};
	private readonly getCurrentStorage = () =>
		this.attached ? this.attachedStorage : this.detachedStorage;
	public readonly createBlob = async (blob: ArrayBufferLike) =>
		this.getCurrentStorage().createBlob(blob);

	public readonly readBlob = async (id: string) => this.getCurrentStorage().readBlob(id);
}

interface MockOrderingServiceEvents {
	op: (op: ISequencedMessageEnvelope) => void;
}

class MockOrderingService {
	public readonly unprocessedOps: ISequencedMessageEnvelope[] = [];
	public readonly events = createEmitter<MockOrderingServiceEvents>();
	public messagesReceived = 0;

	private _paused: boolean = false;
	public pause = () => {
		this._paused = true;
	};

	public unpause = () => {
		this._paused = false;
		this.processAll();
	};

	public readonly processOne = () => {
		const op = this.unprocessedOps.shift();
		assert(op !== undefined, "Tried processing, but none to process");
		this.events.emit("op", op);
	};

	public readonly processAll = () => {
		while (this.unprocessedOps.length > 0) {
			this.processOne();
		}
	};

	public readonly sendBlobAttachOp = (clientId: string, localId: string, remoteId: string) => {
		// BlobManager only checks the metadata, so this cast is good enough.
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		this.unprocessedOps.push({
			clientId,
			metadata: { localId, blobId: remoteId },
		} as ISequencedMessageEnvelope);
		this.messagesReceived++;
		if (!this._paused) {
			this.processAll();
		}
	};
}

class MockGarbageCollector {
	public readonly deletedBlobs: Set<string> = new Set();
	public readonly simulateBlobDeletion = (blobPath: string) => {
		this.deletedBlobs.add(blobPath);
	};
	public readonly isBlobDeleted = (blobPath: string) => {
		return this.deletedBlobs.has(blobPath);
	};
}

class MockRuntime
	extends TypedEventEmitter<IContainerRuntimeEvents>
	implements IBlobManagerRuntime
{
	private _attachState: AttachState = AttachState.Detached;
	public get attachState() {
		return this._attachState;
	}
	public set attachState(value: AttachState) {
		this._attachState = value;
		if (this._attachState === AttachState.Attached) {
			this.emit("attached");
		}
	}
	public disposed: boolean = false;
	public constructor(public readonly baseLogger: ITelemetryBaseLogger) {
		super();
	}
}

const simulateAttach = async (
	storage: MockStorageAdapter,
	runtime: MockRuntime,
	blobManager: BlobManager,
) => {
	assert(runtime.attachState === AttachState.Detached, "Container must be detached");
	await storage.simulateAttach(blobManager.setRedirectTable);
	// Blob storage transfer and redirect table set happens before the runtime transitions to Attaching.
	runtime.attachState = AttachState.Attaching;
	// TODO: Probably want to test stuff between these states
	runtime.attachState = AttachState.Attached;
};

const unpackHandle = (handle: IFluidHandle) => {
	const internalHandle = toFluidHandleInternal(handle);
	const pathParts = internalHandle.absolutePath.split("/");
	return {
		absolutePath: internalHandle.absolutePath,
		localId: pathParts[2],
		payloadPending: isFluidHandleInternalPayloadPending(internalHandle),
	};
};

const waitHandlePayloadShared = async (handle: IFluidHandle): Promise<void> => {
	if (isFluidHandlePayloadPending(handle) && handle.payloadState !== "shared") {
		return new Promise<void>((resolve) => {
			const onPayloadShared = () => {
				resolve();
				handle.events.off("payloadShared", onPayloadShared);
			};
			handle.events.on("payloadShared", onPayloadShared);
		});
	}
};

const ensureBlobsAttached = async (handles: IFluidHandle[]) => {
	return Promise.all(
		handles.map(async (handle) => {
			toFluidHandleInternal(handle).attachGraph();
			return waitHandlePayloadShared(handle);
		}),
	);
};

const getSummaryContentsWithFormatValidation = (
	blobManager: BlobManager,
): {
	attachments: string[] | undefined;
	redirectTable: [string, string][] | undefined;
} => {
	const { summary } = blobManager.summarize();
	const treeEntries = Object.entries(summary.tree);
	const summaryMembers = new Map(treeEntries);
	assert.strictEqual(treeEntries.length, summaryMembers.size, "Unexpected size mismatch");

	let attachments: string[] | undefined;
	let redirectTable: [string, string][] | undefined;

	const redirectTableMember = summaryMembers.get(redirectTableBlobName);
	if (redirectTableMember !== undefined) {
		assert(redirectTableMember.type === SummaryType.Blob);
		assert(typeof redirectTableMember.content === "string");
		redirectTable = [
			...new Map<string, string>(
				JSON.parse(redirectTableMember.content) as [string, string][],
			).entries(),
		];
	}
	summaryMembers.delete(redirectTableBlobName);

	if (summaryMembers.size > 0) {
		attachments = [];
		for (const [, summaryMember] of summaryMembers) {
			assert.strictEqual(
				summaryMember.type,
				SummaryType.Attachment,
				"Remaining summary members must be attachments",
			);
			attachments.push(summaryMember.id);
		}
	}
	return { attachments, redirectTable };
};

const textToBlob = (text: string): ArrayBufferLike => {
	const encoder = new TextEncoder();
	return encoder.encode(text).buffer;
};

const blobToText = (blob: ArrayBufferLike): string => {
	const decoder = new TextDecoder();
	return decoder.decode(blob);
};

for (const createBlobPayloadPending of [false, true]) {
	describe.only(`BlobManager (pending payloads): ${createBlobPayloadPending}`, () => {
		let mockBlobStorage: MockStorageAdapter;
		let mockOrderingService: MockOrderingService;
		let mockGarbageCollector: MockGarbageCollector;
		let mockLogger: MockLogger;
		let mockRuntime: MockRuntime;
		let blobManager: BlobManager;

		beforeEach(() => {
			mockBlobStorage = new MockStorageAdapter();
			mockOrderingService = new MockOrderingService();
			mockGarbageCollector = new MockGarbageCollector();
			mockLogger = new MockLogger();
			mockRuntime = new MockRuntime(mockLogger);

			const clientId = uuid();
			blobManager = new BlobManager({
				routeContext: undefined as unknown as IFluidHandleContext,
				blobManagerLoadInfo: {},
				storage: mockBlobStorage,
				sendBlobAttachOp: (localId: string, storageId: string) =>
					mockOrderingService.sendBlobAttachOp(clientId, localId, storageId),
				blobRequested: () => undefined,
				isBlobDeleted: mockGarbageCollector.isBlobDeleted,
				runtime: mockRuntime,
				stashedBlobs: undefined,
				createBlobPayloadPending,
			});

			mockOrderingService.events.on("op", (op: ISequencedMessageEnvelope) => {
				blobManager.processBlobAttachMessage(op, op.clientId === clientId);
			});
		});

		describe("Detached usage", () => {
			it("Responds as expected for unknown blob IDs", async () => {
				assert(!blobManager.hasBlob("blobId"));
				await assert.rejects(async () => {
					// Handles for detached blobs are never payload pending, even if the flag is set.
					await blobManager.getBlob("blobId", false);
				});
			});

			it("Can create a blob and retrieve it", async () => {
				const handle = await blobManager.createBlob(textToBlob("hello"));
				const { localId } = unpackHandle(handle);
				assert(blobManager.hasBlob(localId));
				// Handles for detached blobs are never payload pending, even if the flag is set.
				assert(!handle.payloadPending);
				const blobFromManager = await blobManager.getBlob(localId, false);
				assert.strictEqual(blobToText(blobFromManager), "hello", "Blob content mismatch");
				const blobFromHandle = await handle.get();
				assert.strictEqual(blobToText(blobFromHandle), "hello", "Blob content mismatch");
				assert.strictEqual(
					mockOrderingService.messagesReceived,
					0,
					"Should not try to send messages in detached state",
				);
			});
		});

		describe("Attaching", () => {
			it("Can attach when empty", async () => {
				await simulateAttach(mockBlobStorage, mockRuntime, blobManager);
			});

			it("Can get a detached blob after attaching", async () => {
				const handle = await blobManager.createBlob(textToBlob("hello"));
				const { localId } = unpackHandle(handle);

				await simulateAttach(mockBlobStorage, mockRuntime, blobManager);

				assert(blobManager.hasBlob(localId));
				// Handles for detached blobs are never payload pending, even if the flag is set.
				const blobFromManager = await blobManager.getBlob(localId, false);
				assert.strictEqual(blobToText(blobFromManager), "hello", "Blob content mismatch");
				const blobFromHandle = await handle.get();
				assert.strictEqual(blobToText(blobFromHandle), "hello", "Blob content mismatch");
			});
		});
		describe("Attached usage", () => {
			beforeEach(async () => {
				await simulateAttach(mockBlobStorage, mockRuntime, blobManager);
			});
			describe("Normal usage", () => {
				it("Responds as expected for unknown blob IDs", async () => {
					assert(!blobManager.hasBlob("blobId"));
					// When payloadPending is false, we throw for unknown blobs
					await assert.rejects(async () => {
						await blobManager.getBlob("blobId", false);
					});
					// When payloadPending is true, we allow the promise to remain pending (waiting
					// for the blob to later arrive)
					const result = await Promise.race([
						blobManager.getBlob("blobId", true),
						new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
					]);
					assert.strictEqual(
						result,
						"timeout",
						"Did not expect promise to settle within timeout window",
					);
				});

				it("Can create a blob and retrieve it", async () => {
					const handle = await blobManager.createBlob(textToBlob("hello"));
					const { localId } = unpackHandle(handle);
					assert(blobManager.hasBlob(localId));
					assert.strictEqual(
						handle.payloadPending,
						createBlobPayloadPending,
						"Wrong handle type created",
					);
					const blobFromManager = await blobManager.getBlob(localId, createBlobPayloadPending);
					assert.strictEqual(blobToText(blobFromManager), "hello", "Blob content mismatch");
					const blobFromHandle = await handle.get();
					assert.strictEqual(blobToText(blobFromHandle), "hello", "Blob content mismatch");
					// TODO: Move this to separate test about network-visible effects of the blob creation?
					// With payloadPending handles, we won't actually upload and send the attach op until the
					// handle is attached.
					if (createBlobPayloadPending) {
						await ensureBlobsAttached([handle]);
					}
					assert.strictEqual(
						mockOrderingService.messagesReceived,
						1,
						"Should have sent one message for blob attach",
					);
				});
			});
			// TODO: beforeEach to create a whole second BlobManager?
			describe("Blobs from remote clients", () => {});
			describe("Disconnect/reconnect", () => {});
			describe("Failure", () => {});
			describe("Abort", () => {});
			describe("getPendingBlobs", () => {});
		});
		describe("Summaries", () => {
			describe("Generating summaries", () => {
				it("Empty summary", () => {
					const { attachments, redirectTable } =
						getSummaryContentsWithFormatValidation(blobManager);
					assert.strictEqual(
						attachments,
						undefined,
						"Shouldn't have attachments for empty summary",
					);
					assert.strictEqual(
						redirectTable,
						undefined,
						"Shouldn't have redirectTable for empty summary",
					);
				});

				it("Detached, non-dedupe storage", async () => {
					await blobManager.createBlob(textToBlob("hello"));
					await blobManager.createBlob(textToBlob("world"));
					await blobManager.createBlob(textToBlob("world"));
					const { attachments, redirectTable } =
						getSummaryContentsWithFormatValidation(blobManager);
					assert.strictEqual(attachments?.length, 3);
					assert.strictEqual(redirectTable?.length, 3);
				});

				it("Deduping after attach", async () => {
					await blobManager.createBlob(textToBlob("hello"));
					await blobManager.createBlob(textToBlob("world"));
					await blobManager.createBlob(textToBlob("world"));
					await simulateAttach(mockBlobStorage, mockRuntime, blobManager);
					const { attachments, redirectTable } =
						getSummaryContentsWithFormatValidation(blobManager);
					// As attach uploads the non-deduped blobs to the deduping storage, the duplicate
					// "world" will remain in the redirectTable (since it has a unique localId), but
					// its attachment will be deduplicated.
					assert.strictEqual(attachments?.length, 2);
					assert.strictEqual(redirectTable?.length, 3);
				});

				it("Attached, dedupe storage", async () => {
					await simulateAttach(mockBlobStorage, mockRuntime, blobManager);
					const handle1 = await blobManager.createBlob(textToBlob("hello"));
					const handle2 = await blobManager.createBlob(textToBlob("world"));
					const handle3 = await blobManager.createBlob(textToBlob("world"));
					// Ensure the blobs are attached so they are included in the summary.
					if (createBlobPayloadPending) {
						await ensureBlobsAttached([handle1, handle2, handle3]);
					}
					const { attachments, redirectTable } =
						getSummaryContentsWithFormatValidation(blobManager);
					assert.strictEqual(attachments?.length, 2);
					assert.strictEqual(redirectTable?.length, 3);
				});

				it("Spanning attach", async () => {
					await blobManager.createBlob(textToBlob("hello"));
					await blobManager.createBlob(textToBlob("world"));
					await blobManager.createBlob(textToBlob("world"));
					await simulateAttach(mockBlobStorage, mockRuntime, blobManager);
					const handle1 = await blobManager.createBlob(textToBlob("hello"));
					const handle2 = await blobManager.createBlob(textToBlob("world"));
					const handle3 = await blobManager.createBlob(textToBlob("another"));
					const handle4 = await blobManager.createBlob(textToBlob("another"));
					// Ensure the blobs are attached so they are included in the summary.
					if (createBlobPayloadPending) {
						await ensureBlobsAttached([handle1, handle2, handle3, handle4]);
					}
					const { attachments, redirectTable } =
						getSummaryContentsWithFormatValidation(blobManager);
					assert.strictEqual(attachments?.length, 3);
					assert.strictEqual(redirectTable?.length, 7);
				});
			});
			describe("Loading from summaries", () => {});
		});
		describe("Garbage collection", () => {});
	});
}
