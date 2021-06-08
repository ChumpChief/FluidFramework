/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { Router } from "express";

export function create(): Router {
    const router: Router = Router();

    router.post(
        "/repos/:ignored?/:tenantId/git/tags",
        (request, response) => {
            throw new Error("Not implemented");
        });

    router.get(
        "/repos/:ignored?/:tenantId/git/tags/*",
        (request, response) => {
            throw new Error("Not implemented");
        });

    return router;
}
