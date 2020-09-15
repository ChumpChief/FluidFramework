/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import querystring from "querystring";
import { fromUtf8ToBase64 } from "@fluidframework/common-utils";
import { IDocumentDeltaStorageService } from "@fluidframework/driver-definitions";
import * as api from "@fluidframework/protocol-definitions";
import Axios from "axios";

/**
 * Storage service limited to only being able to fetch documents for a specific document
 */
export class DocumentDeltaStorageService implements IDocumentDeltaStorageService {
    constructor(
        private readonly tenantId: string,
        private readonly token: string,
        private readonly url: string,
    ) { }

    public async get(from?: number, to?: number): Promise<api.ISequencedDocumentMessage[]> {
        const query = querystring.stringify({ from, to });

        let headers: { Authorization: string } | null = null;

        if (this.token !== "") {
            headers = {
                Authorization: `Basic ${fromUtf8ToBase64(`${this.tenantId}:${this.token}`)}`,
            };
        }

        const opData = await Axios.get<api.ISequencedDocumentMessage[]>(`${this.url}?${query}`, { headers });

        return opData.data;
    }
}
