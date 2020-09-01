/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import querystring from "querystring";
import { fromUtf8ToBase64 } from "@fluidframework/common-utils";
import { IDeltaStorageService, IDocumentDeltaStorageService } from "@fluidframework/driver-definitions";
import * as api from "@fluidframework/protocol-definitions";
import Axios from "axios";
import { TokenProvider } from "./tokens";

/**
 * Storage service limited to only being able to fetch documents for a specific document
 */
export class DocumentDeltaStorageService implements IDocumentDeltaStorageService {
    constructor(
        private readonly tenantId: string,
        private readonly id: string,
        private readonly tokenProvider: api.ITokenProvider,
        private readonly storageService: IDeltaStorageService) {
    }

    public async get(from?: number, to?: number): Promise<api.ISequencedDocumentMessage[]> {
        return this.storageService.get(this.tenantId, this.id, this.tokenProvider, from, to);
    }
}

/**
 * Provides access to the underlying delta storage on the server for routerlicious driver.
 */
export class DeltaStorageService implements IDeltaStorageService {
    constructor(private readonly url: string) {
    }

    public async get(
        tenantId: string,
        id: string,
        tokenProvider: api.ITokenProvider,
        from?: number,
        to?: number): Promise<api.ISequencedDocumentMessage[]> {
        const query = querystring.stringify({ from, to });

        let headers: { Authorization: string } | null = null;

        const token = (tokenProvider as TokenProvider).token;

        if (token) {
            headers = {
                Authorization: `Basic ${fromUtf8ToBase64(`${tenantId}:${token}`)}`,
            };
        }

        const opData = await Axios.get<api.ISequencedDocumentMessage[]>(`${this.url}?${query}`, { headers });

        return opData.data;
    }
}
