/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { RouterliciousDocumentServiceFactory } from "@fluidframework/routerlicious-driver";
import { RouteOptions } from "./loader";

export function getDocumentServiceFactory(documentId: string, options: RouteOptions) {
    switch (options.mode) {
        case "docker":
        case "r11s":
        case "tinylicious":
            return new RouterliciousDocumentServiceFactory();

        default:
            throw new Error("Only supporting Routerlicious");
    }
}
