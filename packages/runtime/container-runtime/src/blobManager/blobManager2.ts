/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import { AttachState } from "@fluidframework/container-definitions";
import type { IEvent } from "@fluidframework/core-interfaces/internal";
import { ISummaryTreeWithStats } from "@fluidframework/runtime-definitions/internal";
import { v4 as uuid } from "uuid";

import { summarizeBlobManagerState } from "./blobManagerSnapSum.js";

interface IDetachedBlobRecord {
	readonly state: "detached";
	readonly localId: string;
	readonly blob: ArrayBufferLike;
}

interface IUploadingBlobRecord {
	readonly state: "uploading";
	readonly localId: string;
	readonly blob: ArrayBufferLike;
}

interface IAttachingBlobRecord {
	readonly state: "attaching";
	readonly localId: string;
	readonly blob: ArrayBufferLike;
	readonly storageId: string;
}

interface IAttachedBlobRecord {
	readonly state: "attached";
	readonly localId: string;
	readonly blob: ArrayBufferLike;
	readonly storageId: string;
}

// TODO: Maybe overkill for tracking, also maybe don't need localId as a member of each entry
type LocalBlobRecord =
	| IDetachedBlobRecord
	| IUploadingBlobRecord
	| IAttachingBlobRecord
	| IAttachedBlobRecord;

interface IBlobManager2InternalEvents extends IEvent {
	(event: "blobAttached", listener: (localId: string, storageId: string) => void);
}

// TODO: telemetry, fix tests
export class BlobManager2 {
	private readonly redirectTable: Map<string, string>;
	private readonly localBlobCache: Map<string, LocalBlobRecord>;
	private readonly internalEvents = new TypedEventEmitter<IBlobManager2InternalEvents>();

	public constructor(
		private readonly createBlob: (file: ArrayBufferLike) => Promise<string>,
		private readonly readBlob: (id: string) => Promise<ArrayBufferLike>,
		redirectEntries: [string, string][],
		private readonly sendBlobAttachOp: (localId: string, storageId: string) => void,
		pendingState?: [string, LocalBlobRecord][] | undefined,
	) {
		this.redirectTable = new Map(redirectEntries);
		this.localBlobCache = new Map(pendingState);
		// TODO: here kick off resume of pending uploads/attaches.  Consider if we need to avoid resending
		// an attach op if it might have already made it (i.e. wait for connected state if reconnecting)?
	}

	public readonly getBlob = async (localId: string): Promise<ArrayBufferLike> => {
		const localBlob = this.localBlobCache.get(localId);
		if (localBlob !== undefined) {
			return localBlob.blob;
		}
		// If we don't find it in the redirectTable, assume the attach op is coming eventually and wait.
		const storageId =
			this.redirectTable.get(localId) ??
			(await new Promise<string>((resolve) => {
				const onBlobAttached = (_localId: string, _storageId: string): void => {
					if (_localId === localId) {
						this.internalEvents.off("blobAttached", onBlobAttached);
						resolve(_storageId);
					}
				};
				this.internalEvents.on("blobAttached", onBlobAttached);
			}));

		return this.readBlob(storageId);
	};

	public readonly createDetachedBlob = (
		blob: ArrayBufferLike,
	): {
		localId: string;
		attach: () => Promise<void>;
	} => {
		const localId = uuid();
		const detachedBlobRecord: IDetachedBlobRecord = {
			state: "detached",
			localId,
			blob,
		};
		this.localBlobCache.set(localId, detachedBlobRecord);
		return {
			localId,
			attach: async () => this.uploadAndAttachBlob(localId),
		};
	};

	// TODO: retry logic, respect ttl, prevent multiple calling
	private readonly uploadAndAttachBlob = async (localId: string): Promise<void> => {
		const detachedBlobRecord = this.localBlobCache.get(localId);
		// TODO: assert if not detached state?
		if (detachedBlobRecord?.state !== "detached") {
			throw new Error("Trying to attach when not allowed");
		}

		const uploadingBlobRecord: IUploadingBlobRecord = {
			...detachedBlobRecord,
			state: "uploading",
		};
		this.localBlobCache.set(localId, uploadingBlobRecord);
		const storageId = await this.createBlob(detachedBlobRecord.blob);

		const attachingBlobRecord: IAttachingBlobRecord = {
			...uploadingBlobRecord,
			state: "attaching",
			storageId,
		};
		this.localBlobCache.set(localId, attachingBlobRecord);

		// Send a blob attach op and also await its ack, so that this function resolves once the blob
		// is fully attached.
		await new Promise<string>((resolve) => {
			const onBlobAttached = (_localId: string, _storageId: string): void => {
				if (_localId === localId) {
					this.internalEvents.off("blobAttached", onBlobAttached);
					resolve(_storageId);
				}
			};
			this.internalEvents.on("blobAttached", onBlobAttached);
			this.sendBlobAttachOp(localId, storageId);
		});
	};

	public readonly notifyBlobAttached = (localId: string, storageId: string): void => {
		this.redirectTable.set(localId, storageId);
		const attachingBlobRecord = this.localBlobCache.get(localId);
		// TODO assert if present but not in attaching state?
		if (attachingBlobRecord?.state === "attaching") {
			const attachedBlobRecord: IAttachedBlobRecord = {
				...attachingBlobRecord,
				state: "attached",
			};
			this.localBlobCache.set(localId, attachedBlobRecord);
		}
		this.internalEvents.emit("blobAttached", localId, storageId);
	};

	public readonly deleteBlob = (localId: string): void => {
		this.redirectTable.delete(localId);
	};

	public readonly knownBlobIds = (): string[] => [...this.redirectTable.keys()];

	public readonly summarize = (): ISummaryTreeWithStats => {
		// TODO: will always act as if attached, don't want to think about attach state at this layer
		return summarizeBlobManagerState(this.redirectTable, AttachState.Attached);
	};

	// TODO: Also filter out detached?
	public readonly getPendingState = (): [string, LocalBlobRecord][] =>
		[...this.localBlobCache].filter(([_, record]) => record.state !== "attached");
}
