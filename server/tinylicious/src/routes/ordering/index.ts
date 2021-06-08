/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { Router } from "express";
import {
    IDocumentStorage,
    MongoManager,
} from "../../server-services-core";
import * as deltas from "./deltas";
import * as documents from "./documents";

export function create(
    storage: IDocumentStorage,
    mongoManager: MongoManager,
): Router {
    const router: Router = Router();
    const deltasRoute = deltas.create(mongoManager);
    const documentsRoute = documents.create(storage);

    router.use("/deltas", deltasRoute);
    router.use("/documents", documentsRoute);

    return router;
}
