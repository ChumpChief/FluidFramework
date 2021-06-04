/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentStorage,
    MongoManager,
} from "@fluidframework/server-services-core";
import { Router } from "express";
import * as ordering from "./ordering";
import * as storage from "./storage";

export interface IRoutes {
    ordering: Router;
    storage: Router;
}

export function create(
    mongoManager: MongoManager,
    documentStorage: IDocumentStorage,
) {
    return {
        ordering: ordering.create(documentStorage, mongoManager),
        storage: storage.create(),
    };
}
