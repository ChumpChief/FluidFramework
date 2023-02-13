/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IBlob,
    ICommit,
    ICommitDetails,
    ICreateBlobParams,
    ICreateBlobResponse,
    ICreateCommitParams,
    ICreateRefParams,
    ICreateTreeParams,
    IHeader,
    IPatchRefParams,
    IRef,
    ITree,
} from "@fluidframework/gitresources";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";

export interface ISharedWorkerPortConnectionMessageToServer {
    type: "REST" | "socket";
    tenantId: string;
    documentId: string;
}

// Start DocumentDeltaConnection messaging

export interface IDocumentDeltaConnectionPayloadToServer {
    type: "emit";
    event: string;
    args: any[];
}
export interface IDocumentDeltaConnectionPayloadFromServer {
    type: "emit";
    event: string;
    args: any[];
}

export interface IDocumentDeltaConnectionMessageToServer {
    service: "documentDeltaConnection";
    payload: IDocumentDeltaConnectionPayloadToServer;
}
export interface IDocumentDeltaConnectionMessageFromServer {
    service: "documentDeltaConnection";
    payload: IDocumentDeltaConnectionPayloadFromServer;
}

// Start DeltaStorage messaging

export interface IDeltaStorageGetDeltasPayloadToServer {
    type: "getDeltas";
    from: number;
    to?: number;
}
export interface IDeltaStorageGetDeltasPayloadFromServer {
    type: "getDeltas";
    data: ISequencedDocumentMessage[];
}

export type IDeltaStoragePayloadToServer = IDeltaStorageGetDeltasPayloadToServer;
export type IDeltaStoragePayloadFromServer = IDeltaStorageGetDeltasPayloadFromServer;

export interface IDeltaStorageMessageToServer {
    service: "deltaStorage";
    requestId: string;
    payload: IDeltaStoragePayloadToServer;
}
export interface IDeltaStorageMessageFromServer {
    service: "deltaStorage";
    requestId: string;
    payload: IDeltaStoragePayloadFromServer;
}

// Start Historian messaging

export interface IHistorianGetHeaderPayloadToServer {
    type: "getHeader";
    sha: string;
}
export interface IHistorianGetHeaderPayloadFromServer {
    type: "getHeader";
    data: IHeader;
}

export interface IHistorianGetBlobPayloadToServer {
    type: "getBlob";
    sha: string;
}
export interface IHistorianGetBlobPayloadFromServer {
    type: "getBlob";
    data: IBlob;
}

export interface IHistorianCreateBlobPayloadToServer {
    type: "createBlob";
    blob: ICreateBlobParams;
}
export interface IHistorianCreateBlobPayloadFromServer {
    type: "createBlob";
    data: ICreateBlobResponse;
}

export interface IHistorianGetContentPayloadToServer {
    type: "getContent";
    path: string;
    ref: string;
}
export interface IHistorianGetContentPayloadFromServer {
    type: "getContent";
    data: any;
}

export interface IHistorianGetCommitsPayloadToServer {
    type: "getCommits";
    sha: string;
    count: number;
}
export interface IHistorianGetCommitsPayloadFromServer {
    type: "getCommits";
    data: ICommitDetails[];
}

export interface IHistorianGetCommitPayloadToServer {
    type: "getCommit";
    sha: string;
}
export interface IHistorianGetCommitPayloadFromServer {
    type: "getCommit";
    data: ICommit;
}

export interface IHistorianCreateCommitPayloadToServer {
    type: "createCommit";
    commit: ICreateCommitParams;
}
export interface IHistorianCreateCommitPayloadFromServer {
    type: "createCommit";
    data: ICommit;
}

export interface IHistorianGetRefPayloadToServer {
    type: "getRef";
    ref: string;
}
export interface IHistorianGetRefPayloadFromServer {
    type: "getRef";
    data: IRef;
}

export interface IHistorianCreateRefPayloadToServer {
    type: "createRef";
    params: ICreateRefParams;
}
export interface IHistorianCreateRefPayloadFromServer {
    type: "createRef";
    data: IRef;
}

export interface IHistorianUpdateRefPayloadToServer {
    type: "updateRef";
    ref: string;
    params: IPatchRefParams;
}
export interface IHistorianUpdateRefPayloadFromServer {
    type: "updateRef";
    data: IRef;
}

export interface IHistorianCreateTreePayloadToServer {
    type: "createTree";
    tree: ICreateTreeParams;
}
export interface IHistorianCreateTreePayloadFromServer {
    type: "createTree";
    data: ITree;
}

export interface IHistorianGetTreePayloadToServer {
    type: "getTree";
    sha: string;
    recursive: boolean;
}
export interface IHistorianGetTreePayloadFromServer {
    type: "getTree";
    data: ITree;
}

export type IHistorianPayloadToServer =
    IHistorianGetHeaderPayloadToServer
    | IHistorianGetBlobPayloadToServer
    | IHistorianCreateBlobPayloadToServer
    | IHistorianGetContentPayloadToServer
    | IHistorianGetCommitsPayloadToServer
    | IHistorianGetCommitPayloadToServer
    | IHistorianCreateCommitPayloadToServer
    | IHistorianGetRefPayloadToServer
    | IHistorianCreateRefPayloadToServer
    | IHistorianUpdateRefPayloadToServer
    | IHistorianCreateTreePayloadToServer
    | IHistorianGetTreePayloadToServer;
export type IHistorianPayloadFromServer =
    IHistorianGetHeaderPayloadFromServer
    | IHistorianGetBlobPayloadFromServer
    | IHistorianCreateBlobPayloadFromServer
    | IHistorianGetContentPayloadFromServer
    | IHistorianGetCommitsPayloadFromServer
    | IHistorianGetCommitPayloadFromServer
    | IHistorianCreateCommitPayloadFromServer
    | IHistorianGetRefPayloadFromServer
    | IHistorianCreateRefPayloadFromServer
    | IHistorianUpdateRefPayloadFromServer
    | IHistorianCreateTreePayloadFromServer
    | IHistorianGetTreePayloadFromServer;

export interface IHistorianMessageToServer {
    service: "historian";
    requestId: string;
    payload: IHistorianPayloadToServer;
}

export interface IHistorianMessageFromServer {
    service: "historian";
    requestId: string;
    payload: IHistorianPayloadFromServer;
}

export type ISharedWorkerMessageToServer =
    IDocumentDeltaConnectionMessageToServer
    | IDeltaStorageMessageToServer
    | IHistorianMessageToServer;
export type ISharedWorkerMessageFromServer =
    IDocumentDeltaConnectionMessageFromServer
    | IDeltaStorageMessageFromServer
    | IHistorianMessageFromServer;
