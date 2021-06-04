/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import * as core from "@fluidframework/server-services-core";

export class ForemanLambda implements core.IPartitionLambda {
    constructor(
        protected context: core.IContext,
        protected tenantId: string,
        protected documentId: string) {
    }

    public close() {
    }

    public async handler(message: core.IQueuedMessage) {
        this.context.checkpoint(message);
    }
}
