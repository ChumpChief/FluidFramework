/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentStorageService,
} from "@fluidframework/driver-definitions";
import {
    ISnapshotTree,
    ITree,
    IVersion,
} from "@fluidframework/protocol-definitions";

export class DocumentStorageServiceProxy implements IDocumentStorageService {
    constructor(protected readonly internalStorageService: IDocumentStorageService) { }

    public async getSnapshotTree(version?: IVersion): Promise<ISnapshotTree | null> {
        return this.internalStorageService.getSnapshotTree(version);
    }

    public async getVersions(count: number): Promise<IVersion[]> {
        return this.internalStorageService.getVersions(count);
    }

    public async read(blobId: string): Promise<string> {
        return this.internalStorageService.read(blobId);
    }

    public async write(tree: ITree, parents: string[], message: string, ref: string): Promise<IVersion> {
        return this.internalStorageService.write(tree, parents, message, ref);
    }

    public async readBlob(blobId: string): Promise<ArrayBufferLike> {
        return this.internalStorageService.readBlob(blobId);
    }
}
