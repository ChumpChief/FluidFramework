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
	type IFluidHandleContext,
	type ITelemetryBaseLogger,
} from "@fluidframework/core-interfaces/internal";
import { MockLogger } from "@fluidframework/telemetry-utils/internal";

import { BlobManager, IBlobManagerRuntime } from "../blobManager/index.js";
import type { IBlobMetadata } from "../metadata.js";

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
	private readonly detachedStorage = new MockBlobStorage(false);
	private readonly attachedStorage = new MockBlobStorage(true);
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

class MockOrderingService {
	public readonly unprocessedOps: IBlobMetadata[] = [];
	public readonly takeNextUnprocessedOp = () => {
		const next = this.unprocessedOps.shift();
		assert(next !== undefined, "Tried processing, but none to process");
		return next;
	};
	public readonly sendBlobAttachOp = (localId: string, blobId: string) => {
		this.unprocessedOps.push({ localId, blobId });
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

// const textBlob = (text: string): ArrayBufferLike => {
// 	const encoder = new TextEncoder();
// 	// Casting because TS is mad about the toString tag being different for SharedArrayBuffer
// 	return encoder.encode(text) as unknown as ArrayBufferLike;
// };

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

			blobManager = new BlobManager({
				routeContext: undefined as unknown as IFluidHandleContext,
				blobManagerLoadInfo: {},
				storage: mockBlobStorage,
				sendBlobAttachOp: mockOrderingService.sendBlobAttachOp,
				blobRequested: () => undefined,
				isBlobDeleted: mockGarbageCollector.isBlobDeleted,
				runtime: mockRuntime,
				stashedBlobs: undefined,
				createBlobPayloadPending: false,
			});
		});

		it("Smoke test", async () => {
			assert(!blobManager.hasBlob("blobId"));
			await simulateAttach(mockBlobStorage, mockRuntime, blobManager);
		});
	});
}
