/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IUser } from "./users";

export interface ITokenClaims {
    documentId: string;
    scopes: string[];
    tenantId: string;
    user: IUser;
    iat: number;
    exp: number;
    ver: string;
}
