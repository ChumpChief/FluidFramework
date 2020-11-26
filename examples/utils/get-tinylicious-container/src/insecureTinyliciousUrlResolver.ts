/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IRequest } from "@fluidframework/core-interfaces";
import {
    IFluidResolvedUrl,
    IUrlResolver,
} from "@fluidframework/driver-definitions";
import { ITokenClaims } from "@fluidframework/protocol-definitions";
import { KJUR as jsrsasign } from "jsrsasign";
import { v4 as uuid } from "uuid";
/**
 * InsecureTinyliciousUrlResolver knows how to get the URLs to the service (in this case Tinylicious) to use
 * for a given request.  This particular implementation has a goal to avoid imposing requirements on the app's
 * URL shape, so it expects the request url to have this format (as opposed to a more traditional URL):
 * documentId/containerRelativePathing
 */
export class InsecureTinyliciousUrlResolver implements IUrlResolver {
    public async resolve(request: IRequest): Promise<IFluidResolvedUrl> {
        const documentId = request.url.split("/")[0];
        const encodedDocId = encodeURIComponent(documentId);
        const documentRelativePath = request.url.slice(documentId.length);

        const response: IFluidResolvedUrl = {
            endpoints: {
                deltaStorageUrl: `http://localhost:3000/deltas/tinylicious/${encodedDocId}`,
                ordererUrl: "http://localhost:3000",
                storageUrl: `http://localhost:3000/repos/tinylicious`,
            },
            tokens: { jwt: this.auth(documentId) },
            type: "fluid",
            url: `fluid://localhost:3000/tinylicious/${encodedDocId}${documentRelativePath}`,
        };
        return response;
    }

    private auth(documentId: string) {
        const claims: ITokenClaims = {
            documentId,
            scopes: ["doc:read", "doc:write", "summary:write"],
            tenantId: "tinylicious",
            user: { id: uuid() },
            iat: Math.round(new Date().getTime() / 1000),
            exp: Math.round(new Date().getTime() / 1000) + 60 * 60, // 1 hour expiration
            ver: "1.0",
        };

        const utf8Key = { utf8: "12345" };
        // eslint-disable-next-line no-null/no-null
        return jsrsasign.jws.JWS.sign(null, JSON.stringify({ alg:"HS256", typ: "JWT" }), claims, utf8Key);
    }
}
