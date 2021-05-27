/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IFluidObject, IRequest, IResponse } from "@fluidframework/core-interfaces";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import { RequestParser, create404Response } from "@fluidframework/runtime-utils";

/**
 * Pipe through container request into internal request.
 * If request is empty and default url is provided, redirect request to such default url.
 * @param defaultRootId - optional default root data store ID to pass request in case request is empty.
 */
export const defaultRouteRequestHandler = (defaultRootId: string) => {
    return async (request: IRequest, runtime: IContainerRuntime) => {
        const parser = RequestParser.create(request);
        if (parser.pathParts.length === 0) {
            return runtime.IFluidHandleContext.resolveHandle({
                url: `/${defaultRootId}${parser.query}`,
                headers: request.headers });
        }
        return undefined; // continue search
    };
};

/**
 * Default request handler for a Fluid object that returns the object itself if:
 *  1. the request url is empty
 *  2. the request url is "/"
 *  3. the request url starts with "/" and is followed by a query param, such as /?key=value
 * Returns a 404 error for any other url.
 */
export function defaultFluidObjectRequestHandler(fluidObject: IFluidObject, request: IRequest): IResponse {
    if (request.url === "" || request.url === "/" || request.url.startsWith("/?")) {
        return { mimeType: "fluid/object", status: 200, value: fluidObject };
    } else {
        return create404Response(request);
    }
}
