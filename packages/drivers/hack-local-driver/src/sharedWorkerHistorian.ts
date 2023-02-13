/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IBlob,
    ICreateBlobParams,
    ICreateBlobResponse,
    ICommit,
    ICommitDetails,
    ICreateCommitParams,
    ICreateRefParams,
    ICreateTagParams,
    ICreateTreeParams,
    IHeader,
    IPatchRefParams,
    IRef,
    ITag,
    ITree,
} from "@fluidframework/gitresources";
import {
    IHistorianCreateBlobPayloadFromServer,
    IHistorianCreateBlobPayloadToServer,
    IHistorianCreateCommitPayloadFromServer,
    IHistorianCreateCommitPayloadToServer,
    IHistorianCreateRefPayloadFromServer,
    IHistorianCreateRefPayloadToServer,
    IHistorianCreateTreePayloadFromServer,
    IHistorianCreateTreePayloadToServer,
    IHistorianGetBlobPayloadFromServer,
    IHistorianGetBlobPayloadToServer,
    IHistorianGetCommitPayloadFromServer,
    IHistorianGetCommitPayloadToServer,
    IHistorianGetCommitsPayloadFromServer,
    IHistorianGetCommitsPayloadToServer,
    IHistorianGetContentPayloadFromServer,
    IHistorianGetContentPayloadToServer,
    IHistorianGetHeaderPayloadFromServer,
    IHistorianGetHeaderPayloadToServer,
    IHistorianGetRefPayloadFromServer,
    IHistorianGetRefPayloadToServer,
    IHistorianGetTreePayloadFromServer,
    IHistorianGetTreePayloadToServer,
    IHistorianMessageToServer,
    IHistorianPayloadFromServer,
    IHistorianPayloadToServer,
    IHistorianUpdateRefPayloadFromServer,
    IHistorianUpdateRefPayloadToServer,
    ISharedWorkerMessageFromServer,
} from "@fluidframework/server-hack-local-server";
import {
    IHistorian,
    IWholeFlatSummary,
    IWholeSummaryPayload,
    IWriteSummaryResponse,
} from "@fluidframework/server-services-client";

import { v4 as uuid } from "uuid";

export class SharedWorkerHistorian implements IHistorian {
    public get endpoint(): string {
        throw new Error("Not implemented, don't use it");
    }

    public constructor(private readonly port: MessagePort) { }

    private async issueRequest<TResponsePayload extends IHistorianPayloadFromServer>(
        requestPayload: IHistorianPayloadToServer,
    ): Promise<TResponsePayload> {
        const requestId = uuid();

        const message: IHistorianMessageToServer = {
            service: "historian",
            requestId,
            payload: requestPayload,
        };

        const responsePayloadP = new Promise<IHistorianPayloadFromServer>((resolve) => {
            const messageListener = (e) => {
                const response: ISharedWorkerMessageFromServer = e.data;
                if (response.service !== "historian" || response.requestId !== message.requestId) {
                    return;
                }

                resolve(response.payload);
                this.port.removeEventListener("message", messageListener);
            };
            this.port.addEventListener("message", messageListener);
        });

        this.port.postMessage(message);

        const responsePayload = await responsePayloadP;
        if (responsePayload.type !== requestPayload.type) {
            throw new Error(`Unexpected response payload type: ${responsePayload.type}`);
        }

        return responsePayload as TResponsePayload;
    }

    public async getHeader(sha: string): Promise<IHeader> {
        const requestPayload: IHistorianGetHeaderPayloadToServer = {
            type: "getHeader",
            sha,
        };
        const responsePayload = await this.issueRequest<IHistorianGetHeaderPayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async getFullTree(sha: string): Promise<any> {
        throw new Error("Not supported");
    }
    public async getBlob(sha: string): Promise<IBlob> {
        const requestPayload: IHistorianGetBlobPayloadToServer = {
            type: "getBlob",
            sha,
        };
        const responsePayload = await this.issueRequest<IHistorianGetBlobPayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async createBlob(blob: ICreateBlobParams): Promise<ICreateBlobResponse> {
        const requestPayload: IHistorianCreateBlobPayloadToServer = {
            type: "createBlob",
            blob,
        };
        const responsePayload = await this.issueRequest<IHistorianCreateBlobPayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async getContent(path: string, ref: string): Promise<any> {
        const requestPayload: IHistorianGetContentPayloadToServer = {
            type: "getContent",
            path,
            ref,
        };
        const responsePayload = await this.issueRequest<IHistorianGetContentPayloadFromServer>(requestPayload);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return responsePayload.data;
    }
    public async getCommits(sha: string, count: number): Promise<ICommitDetails[]> {
        const requestPayload: IHistorianGetCommitsPayloadToServer = {
            type: "getCommits",
            sha,
            count,
        };
        const responsePayload = await this.issueRequest<IHistorianGetCommitsPayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async getCommit(sha: string): Promise<ICommit> {
        const requestPayload: IHistorianGetCommitPayloadToServer = {
            type: "getCommit",
            sha,
        };
        const responsePayload = await this.issueRequest<IHistorianGetCommitPayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async createCommit(commit: ICreateCommitParams): Promise<ICommit> {
        const requestPayload: IHistorianCreateCommitPayloadToServer = {
            type: "createCommit",
            commit,
        };
        const responsePayload = await this.issueRequest<IHistorianCreateCommitPayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async getRefs(): Promise<IRef[]> {
        throw new Error("Not supported");
    }
    public async getRef(ref: string): Promise<IRef> {
        const requestPayload: IHistorianGetRefPayloadToServer = {
            type: "getRef",
            ref,
        };
        const responsePayload = await this.issueRequest<IHistorianGetRefPayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async createRef(params: ICreateRefParams): Promise<IRef> {
        const requestPayload: IHistorianCreateRefPayloadToServer = {
            type: "createRef",
            params,
        };
        const responsePayload = await this.issueRequest<IHistorianCreateRefPayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async updateRef(ref: string, params: IPatchRefParams): Promise<IRef> {
        const requestPayload: IHistorianUpdateRefPayloadToServer = {
            type: "updateRef",
            ref,
            params,
        };
        const responsePayload = await this.issueRequest<IHistorianUpdateRefPayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async deleteRef(ref: string): Promise<void> {
        throw new Error("Not supported");
    }
    public async createTag(tag: ICreateTagParams): Promise<ITag> {
        throw new Error("Not supported");
    }
    public async getTag(tag: string): Promise<ITag> {
        throw new Error("Not supported");
    }
    public async createTree(tree: ICreateTreeParams): Promise<ITree> {
        const requestPayload: IHistorianCreateTreePayloadToServer = {
            type: "createTree",
            tree,
        };
        const responsePayload = await this.issueRequest<IHistorianCreateTreePayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async getTree(sha: string, recursive: boolean): Promise<ITree> {
        const requestPayload: IHistorianGetTreePayloadToServer = {
            type: "getTree",
            sha,
            recursive,
        };
        const responsePayload = await this.issueRequest<IHistorianGetTreePayloadFromServer>(requestPayload);
        return responsePayload.data;
    }
    public async createSummary(summary: IWholeSummaryPayload): Promise<IWriteSummaryResponse> {
        throw new Error("Not supported");
    }
    public async deleteSummary(softDelete: boolean): Promise<void> {
        throw new Error("Not supported");
    }
    public async getSummary(sha: string): Promise<IWholeFlatSummary> {
        throw new Error("Not supported");
    }
}
