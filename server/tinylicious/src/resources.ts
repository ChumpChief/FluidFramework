/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentStorage,
    IOrdererManager,
    IResources,
    ITenantManager,
    IWebServerFactory,
    MongoManager,
} from "./server-services-core";

export class TinyliciousResources implements IResources {
    constructor(
        public orderManager: IOrdererManager,
        public tenantManager: ITenantManager,
        public storage: IDocumentStorage,
        public mongoManager: MongoManager,
        public port: any,
        public webServerFactory: IWebServerFactory,
    ) {
    }

    public async dispose(): Promise<void> {
        await this.mongoManager.close();
    }
}
