/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert, gitHashFile, IsoBuffer, Uint8ArrayToString, unreachableCase } from "../../common-utils";
import { ICreateTreeEntry } from "../../gitresources";
import { getGitMode, getGitType } from "../../protocol-base";
import {
    ISummaryTree,
    SummaryObject,
    SummaryType,
} from "../../protocol-definitions";
import { ISummaryUploadManager, IGitManager } from "./storage";

/**
 * Recursively writes summary tree as individual summary blobs.
 */
export class SummaryTreeUploadManager implements ISummaryUploadManager {
    constructor(
        private readonly manager: IGitManager,
        private readonly blobsShaCache: Map<string, string>,
    ) { }

    public async writeSummaryTree(
        summaryTree: ISummaryTree,
        parentHandle: string,
    ): Promise<string> {
        return this.writeSummaryTreeCore(summaryTree);
    }

    private async writeSummaryTreeCore(
        summaryTree: ISummaryTree,
    ): Promise<string> {
        const entries = await Promise.all(Object.keys(summaryTree.tree).map(async (key) => {
            const entry = summaryTree.tree[key];
            const pathHandle = await this.writeSummaryTreeObject(entry);
            const treeEntry: ICreateTreeEntry = {
                mode: getGitMode(entry),
                path: encodeURIComponent(key),
                sha: pathHandle,
                type: getGitType(entry),
            };
            return treeEntry;
        }));

        const treeHandle = await this.manager.createGitTree({ tree: entries });
        return treeHandle.sha;
    }

    private async writeSummaryTreeObject(
        object: SummaryObject,
    ): Promise<string> {
        switch (object.type) {
            case SummaryType.Blob: {
                return this.writeSummaryBlob(object.content);
            }
            case SummaryType.Handle: {
                throw Error("Parent summary does not exist to reference by handle.");
            }
            case SummaryType.Tree: {
                return this.writeSummaryTreeCore(object);
            }
            case SummaryType.Attachment: {
                return object.id;
            }

            default:
                unreachableCase(object, `Unknown type: ${(object as any).type}`);
        }
    }

    private async writeSummaryBlob(content: string | Uint8Array): Promise<string> {
        const { parsedContent, encoding } = typeof content === "string"
            ? { parsedContent: content, encoding: "utf-8" }
            : { parsedContent: Uint8ArrayToString(content, "base64"), encoding: "base64" };

        // The gitHashFile would return the same hash as returned by the server as blob.sha
        const hash = await gitHashFile(IsoBuffer.from(parsedContent, encoding));
        if (!this.blobsShaCache.has(hash)) {
            this.blobsShaCache.set(hash, "");
            const blob = await this.manager.createBlob(parsedContent, encoding);
            assert(hash === blob.sha, 0x0b6 /* "Blob.sha and hash do not match!!" */);
        }
        return hash;
    }
}
