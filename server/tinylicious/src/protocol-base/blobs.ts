/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { unreachableCase } from "../common-utils";
import * as git from "../gitresources";
import {
    FileMode,
    ISnapshotTreeEx,
    SummaryType,
    SummaryObject,
} from "../protocol-definitions";
/**
 * Take a summary object and returns its git mode.
 *
 * @param value - summary object
 * @returns the git mode of summary object
 */
export function getGitMode(value: SummaryObject): string {
    const type = value.type === SummaryType.Handle ? value.handleType : value.type;
    switch (type) {
        case SummaryType.Blob:
        case SummaryType.Attachment:
            return FileMode.File;
        case SummaryType.Tree:
            return FileMode.Directory;
        default:
            unreachableCase(type, `Unknown type: ${type}`);
    }
}

/**
 * Take a summary object and returns its type.
 *
 * @param value - summary object
 * @returns the type of summary object
 */
export function getGitType(value: SummaryObject): "blob" | "tree" {
    const type = value.type === SummaryType.Handle ? value.handleType : value.type;

    switch (type) {
        case SummaryType.Blob:
        case SummaryType.Attachment:
            return "blob";
        case SummaryType.Tree:
            return "tree";
        default:
            unreachableCase(type, `Unknown type: ${type}`);
    }
}

/**
 * Build a tree hierarchy base on a flat tree
 *
 * @param flatTree - a flat tree
 * @param blobsShaToPathCache - Map with blobs sha as keys and values as path of the blob.
 * @returns the hierarchical tree
 */
export function buildHierarchy(
    flatTree: git.ITree,
    blobsShaToPathCache: Map<string, string> = new Map<string, string>()): ISnapshotTreeEx {
    const lookup: { [path: string]: ISnapshotTreeEx } = {};
    const root: ISnapshotTreeEx = { id: flatTree.sha, blobs: {}, commits: {}, trees: {} };
    lookup[""] = root;

    for (const entry of flatTree.tree) {
        const lastIndex = entry.path.lastIndexOf("/");
        const entryPathDir = entry.path.slice(0, Math.max(0, lastIndex));
        const entryPathBase = entry.path.slice(lastIndex + 1);

        // The flat output is breadth-first so we can assume we see tree nodes prior to their contents
        const node = lookup[entryPathDir];

        // Add in either the blob or tree
        if (entry.type === "tree") {
            const newTree = { id: entry.sha, blobs: {}, commits: {}, trees: {} };
            node.trees[decodeURIComponent(entryPathBase)] = newTree;
            lookup[entry.path] = newTree;
        } else if (entry.type === "blob") {
            node.blobs[decodeURIComponent(entryPathBase)] = entry.sha;
            blobsShaToPathCache.set(entry.sha, `/${entry.path}`);
        } else if (entry.type === "commit") {
            node.commits[decodeURIComponent(entryPathBase)] = entry.sha;
        }
    }

    return root;
}
