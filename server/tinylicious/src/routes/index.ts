/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentStorage,
    MongoManager,
} from "@fluidframework/server-services-core";
import * as ordering from "./ordering";
import * as storage from "./storage";

export function createOrderingRouter(
    mongoManager: MongoManager,
    documentStorage: IDocumentStorage,
) {
    return ordering.create(documentStorage, mongoManager);
}

export function createStorageRouter() {
    return storage.create();
}
