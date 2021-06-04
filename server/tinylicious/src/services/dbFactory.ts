/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDb, IDbFactory } from "@fluidframework/server-services-core";
import { Provider } from "nconf";
import { InMemoryDb } from "./inMemorydb";

export class DbFactory implements IDbFactory {
    private readonly db;

    constructor(config: Provider) {
        this.db = new InMemoryDb();
    }

    public async connect(): Promise<IDb> {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return this.db;
    }
}
