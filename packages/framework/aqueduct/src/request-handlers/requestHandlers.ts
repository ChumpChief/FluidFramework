/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IRequest } from "@fluidframework/core-interfaces";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import { RequestParser } from "@fluidframework/runtime-utils";

/**
 * Pipe through container request into internal request.
 * If request is empty and default url is provided, redirect request to such default url.
 * @param defaultRootId - optional default root data store ID to pass request in case request is empty.
 */
export const defaultRouteRequestHandler = (defaultRootId: string) => {
    return async (request: IRequest, runtime: IContainerRuntime) => {
        const parser = new RequestParser(request);
        if (parser.pathParts.length === 0) {
            return runtime.IFluidHandleContext.resolveHandle({
                url: `/${defaultRootId}${parser.query}`,
                headers: request.headers });
        }
        return undefined; // continue search
    };
};
