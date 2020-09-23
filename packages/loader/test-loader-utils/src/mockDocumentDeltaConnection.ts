/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDocumentDeltaConnection, IDocumentDeltaConnectionEvents } from "@fluidframework/driver-definitions";
import {
    ConnectionMode,
    IDocumentMessage,
    INack,
    ISequencedDocumentMessage,
    ITokenClaims,
} from "@fluidframework/protocol-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";

/**
 * Mock Document Delta Connection for testing
 */
export class MockDocumentDeltaConnection
    extends TypedEventEmitter<IDocumentDeltaConnectionEvents>
    implements IDocumentDeltaConnection {
    public claims: ITokenClaims = {
        documentId: "documentId",
        scopes: ["doc:read", "doc:write", "summary:write"],
        tenantId: "tenantId",
        user: {
            id: "mockid",
        },
    };

    public readonly mode: ConnectionMode = "write";
    public readonly existing: boolean = true;
    public readonly maxMessageSize: number = 16 * 1024;
    public readonly version: string = "";
    public initialMessages: ISequencedDocumentMessage[] = [];

    constructor(
        public readonly clientId: string,
        private readonly submitHandler?: (messages: IDocumentMessage[]) => void,
    ) {
        super();
    }

    public submit(messages: IDocumentMessage[]): void {
        if (this.submitHandler !== undefined) {
            this.submitHandler(messages);
        }
    }

    public disconnect(reason?: string) {
        this.emit("disconnect", reason ?? "mock disconnect called");
    }

    // Mock methods for raising events
    public emitOp(documentId: string, messages: Partial<ISequencedDocumentMessage>[]) {
        this.emit("op", documentId, messages);
    }
    public emitNack(documentId: string, message: Partial<INack>[]) {
        this.emit("nack", documentId, message);
    }
    public emitError(error: any) {
        this.emit("error", error);
    }
}
