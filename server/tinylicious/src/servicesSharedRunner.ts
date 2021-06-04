/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import * as path from "path";
import nconf from "nconf";
import { TinyliciousResourcesFactory } from "./resourcesFactory";
import { TinyliciousRunnerFactory } from "./runnerFactory";
import { IResources, IResourcesFactory, IRunnerFactory } from "./services";

/**
 * Uses the provided factories to create and execute a runner.
 */
export async function run<T extends IResources>(
    config: nconf.Provider,
    resourceFactory: IResourcesFactory<T>,
    runnerFactory: IRunnerFactory<T>,
) {
    const resources = await resourceFactory.create(config);
    const runner = await runnerFactory.create(resources);

    // Start the runner and then listen for the message to stop it
    const runningP = runner
        .start()
        .catch(async (error) => {
            await runner
                    .stop()
                    .catch(() => {
                        error.forceKill = true;
                    });
            return Promise.reject(error);
        });

    process.on("SIGTERM", () => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        runner.stop();
    });

    // Wait for the runner to complete
    await runningP;

    // And then dispose of any resources
    await resources.dispose();
}

/**
 * Variant of run that is used to fully run a service. It configures base settings such as logging. And then will
 * exit the service once the runner completes.
 */
export function runService() {
    const resourceFactory = new TinyliciousResourcesFactory();
    const runnerFactory = new TinyliciousRunnerFactory();
    const configPath = path.join(__dirname, "../config.json");

    const config = nconf.argv().env({ separator: "__", parseValues: true }).file(configPath).use("memory");

    const runningP = run(config, resourceFactory, runnerFactory);

    runningP.then(
        () => {
            process.exit(0);
        },
        (error) => {
            if (error.forceKill) {
                process.kill(process.pid, "SIGKILL");
            } else {
                process.exit(1);
            }
        });
}
