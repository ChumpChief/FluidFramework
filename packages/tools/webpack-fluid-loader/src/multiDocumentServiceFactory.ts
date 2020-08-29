/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ILocalDeltaConnectionServer, LocalDeltaConnectionServer } from "@fluidframework/server-local-server";
import { LocalDocumentServiceFactory, LocalSessionStorageDbFactory } from "@fluidframework/local-driver";
import { OdspDocumentServiceFactory } from "@fluidframework/odsp-driver";
import { RouterliciousDocumentServiceFactory } from "@fluidframework/routerlicious-driver";
import { RouteOptions } from "./loader";

const deltaConns = new Map<string, ILocalDeltaConnectionServer>();

export function getDocumentServiceFactory(documentId: string, options: RouteOptions) {
    switch (options.mode) {
        case "docker":
        case "r11s":
        case "tinylicious":
            return new RouterliciousDocumentServiceFactory();

        case "spo":
        case "spo-df":
            // TODO: web socket token
            return new OdspDocumentServiceFactory(
                async () => options.mode === "spo" || options.mode === "spo-df" ? options.odspAccessToken : undefined,
                async () => options.mode === "spo" || options.mode === "spo-df" ? options.pushAccessToken : undefined,
            );

        default: { // Local
            const deltaConn = deltaConns.get(documentId) ??
                LocalDeltaConnectionServer.create(new LocalSessionStorageDbFactory(documentId));
            deltaConns.set(documentId, deltaConn);
            return new LocalDocumentServiceFactory(deltaConn);
        }
    }
}
