/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { TinyliciousResources } from "./resources";
import { TinyliciousRunner } from "./runner";
import { IRunner, IRunnerFactory } from "./services";

export class TinyliciousRunnerFactory implements IRunnerFactory<TinyliciousResources> {
    public async create(resources: TinyliciousResources): Promise<IRunner> {
        return new TinyliciousRunner(
            resources.webServerFactory,
            resources.config,
            resources.port,
            resources.orderManager,
            resources.tenantManager,
            resources.storage,
            resources.mongoManager);
    }
}
