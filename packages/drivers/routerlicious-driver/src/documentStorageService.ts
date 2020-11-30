/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IsoBuffer, Uint8ArrayToString } from "@fluidframework/common-utils";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import { buildHierarchy } from "@fluidframework/protocol-base";
import {
    ICreateBlobResponse,
    ISnapshotTree,
    ITree,
    IVersion,
} from "@fluidframework/protocol-definitions";
import * as gitStorage from "@fluidframework/server-services-client";

/**
 * Document access to underlying storage for routerlicious driver.
 */
export class DocumentStorageService implements IDocumentStorageService {
    // The values of this cache is useless. We only need the keys. So we are always putting
    // empty strings as values.
    private readonly blobsShaCache = new Map<string, string>();

    constructor(private readonly id: string, private readonly manager: gitStorage.GitManager) {
    }

    public async getSnapshotTree(version?: IVersion): Promise<ISnapshotTree | null> {
        let requestVersion = version;
        if (!requestVersion) {
            const versions = await this.getVersions(this.id, 1);
            if (versions.length === 0) {
                return null;
            }

            requestVersion = versions[0];
        }

        const tree = await this.manager.getTree(requestVersion.treeId);
        return buildHierarchy(tree, this.blobsShaCache);
    }

    public async getVersions(versionId: string, count: number): Promise<IVersion[]> {
        const commits = await this.manager.getCommits(versionId ? versionId : this.id, count);
        return commits.map((commit) => ({
            date: commit.commit.author.date,
            id: commit.sha,
            treeId: commit.commit.tree.sha,
        }));
    }

    public async read(blobId: string): Promise<string> {
        const value = await this.manager.getBlob(blobId);
        this.blobsShaCache.set(value.sha, "");
        return value.content;
    }

    public async write(tree: ITree, parents: string[], message: string, ref: string): Promise<IVersion> {
        const branch = ref ? `datastores/${this.id}/${ref}` : this.id;
        const commit = await this.manager.write(branch, tree, parents, message);
        return { date: commit.committer.date, id: commit.sha, treeId: commit.tree.sha };
    }

    public async createBlob(file: ArrayBufferLike): Promise<ICreateBlobResponse> {
        const response = this.manager.createBlob(
            Uint8ArrayToString(
                new Uint8Array(file), "base64"),
            "base64");

        return response.then((r) => ({ id: r.sha, url: r.url }));
    }

    public async readBlob(blobId: string): Promise<ArrayBufferLike> {
        const iso = IsoBuffer.from(await this.read(blobId), "base64");

        // In a Node environment, IsoBuffer may be a Node.js Buffer.  Node.js will
        // pool multiple small Buffer instances into a single ArrayBuffer, in which
        // case we need to slice the appropriate span of bytes.
        return iso.byteLength === iso.buffer.byteLength
            ? iso.buffer
            : iso.buffer.slice(iso.byteOffset, iso.byteOffset + iso.byteLength);
    }
}
