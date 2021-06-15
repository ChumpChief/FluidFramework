/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import * as git from "../../gitresources";
import { RestWrapper, BasicRestWrapper } from "./restWrapper";
import { IHistorian } from "./storage";

function endsWith(value: string, endings: string[]): boolean {
    for (const ending of endings) {
        if (value.endsWith(ending)) {
            return true;
        }
    }

    return false;
}

/**
 * Implementation of the IHistorian interface that calls out to a REST interface
 */
export class Historian implements IHistorian {
    private readonly defaultQueryString: Record<string, unknown> = {};
    private readonly cacheBust: boolean = false;
    private readonly restWrapper: RestWrapper;

    constructor(public endpoint: string) {
        this.restWrapper = new BasicRestWrapper(this.endpoint);
    }

    public getHeader(sha: string): Promise<any> {
        return this.getHeaderDirect(sha);
    }

    public getFullTree(sha: string): Promise<any> {
        return this.restWrapper.get(`/tree/${encodeURIComponent(sha)}`, this.getQueryString());
    }

    public getBlob(sha: string): Promise<git.IBlob> {
        return this.restWrapper.get<git.IBlob>(
            `/git/blobs/${encodeURIComponent(sha)}`, this.getQueryString());
    }

    public createBlob(blob: git.ICreateBlobParams): Promise<git.ICreateBlobResponse> {
        return this.restWrapper.post<git.ICreateBlobResponse>(
            `/git/blobs`, blob, this.getQueryString());
    }

    public getContent(path: string, ref: string): Promise<any> {
        return this.restWrapper.get(`/contents/${path}`, this.getQueryString({ ref }));
    }

    public getCommits(sha: string, count: number): Promise<git.ICommitDetails[]> {
        return this.restWrapper.get<git.ICommitDetails[]>(
            `/commits`, this.getQueryString({ count, sha }))
                .catch((error) => (error === 400 || error === 404) ?
                    [] as git.ICommitDetails[] : Promise.reject<git.ICommitDetails[]>(error));
    }

    public getCommit(sha: string): Promise<git.ICommit> {
        return this.restWrapper.get<git.ICommit>(
            `/git/commits/${encodeURIComponent(sha)}`, this.getQueryString());
    }

    public createCommit(commit: git.ICreateCommitParams): Promise<git.ICommit> {
        return this.restWrapper.post<git.ICommit>(`/git/commits`, commit, this.getQueryString());
    }

    public getRefs(): Promise<git.IRef[]> {
        return this.restWrapper.get(`/git/refs`, this.getQueryString());
    }

    public getRef(ref: string): Promise<git.IRef> {
        return this.restWrapper.get(`/git/refs/${ref}`, this.getQueryString());
    }

    public createRef(params: git.ICreateRefParams): Promise<git.IRef> {
        return this.restWrapper.post(`/git/refs`, params, this.getQueryString());
    }

    public updateRef(ref: string, params: git.IPatchRefParams): Promise<git.IRef> {
        return this.restWrapper.patch(`/git/refs/${ref}`, params, this.getQueryString());
    }

    public async deleteRef(ref: string): Promise<void> {
        await this.restWrapper.delete(`/git/refs/${ref}`, this.getQueryString());
    }

    public createTree(tree: git.ICreateTreeParams): Promise<git.ITree> {
        return this.restWrapper.post<git.ITree>(`/git/trees`, tree, this.getQueryString(tree));
    }

    public getTree(sha: string, recursive: boolean): Promise<git.ITree> {
        return this.restWrapper.get<git.ITree>(
            `/git/trees/${encodeURIComponent(sha)}`,
            this.getQueryString({ recursive: recursive ? 1 : 0 }));
    }

    private async getHeaderDirect(sha: string): Promise<git.IHeader> {
        const tree = await this.getTree(sha, true);

        const includeBlobs = [".attributes", ".blobs", ".messages", "header"];

        const blobsP: Promise<git.IBlob>[] = [];
        for (const entry of tree.tree) {
            if (entry.type === "blob" && endsWith(entry.path, includeBlobs)) {
                const blobP = this.getBlob(entry.sha);
                blobsP.push(blobP);
            }
        }
        const blobs = await Promise.all(blobsP);

        return {
            blobs,
            tree,
        };
    }

    // eslint-disable-next-line @typescript-eslint/ban-types
    private getQueryString(queryString?: {}): Record<string, unknown> {
        if (this.cacheBust) {
            return {
                cacheBust: Date.now(),
                ...this.defaultQueryString,
                ...queryString,
            };
        }
        return {
            ...this.defaultQueryString,
            ...queryString,
        };
    }
}
