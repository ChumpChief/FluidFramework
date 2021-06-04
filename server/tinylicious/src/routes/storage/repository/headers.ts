/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IHeader } from "@fluidframework/gitresources";
import { Router } from "express";
import * as utils from "../utils";

export async function getHeader(
    tenantId: string,
    authorization: string,
    sha: string,
    useCache: boolean,
): Promise<IHeader> {
    throw new Error("Not implemented");
}

export async function getTree(
    tenantId: string,
    authorization: string,
    sha: string,
    useCache: boolean,
): Promise<any> {
    throw new Error("Not implemented");
}

export function create(): Router {
    const router: Router = Router();

    router.get(
        "/repos/:ignored?/:tenantId/headers/:sha",
        (request, response) => {
            const useCache = !("disableCache" in request.query);
            const headerP = getHeader(
                request.params.tenantId,
                request.get("Authorization"),
                request.params.sha,
                useCache);

            utils.handleResponse(headerP, response, useCache);
        });

    router.get(
        "/repos/:ignored?/:tenantId/tree/:sha",
        (request, response) => {
            const useCache = !("disableCache" in request.query);
            const headerP = getTree(
                request.params.tenantId,
                request.get("Authorization"),
                request.params.sha,
                useCache);

            utils.handleResponse(headerP, response, useCache);
        });

    return router;
}
