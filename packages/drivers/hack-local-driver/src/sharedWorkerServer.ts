/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { SharedWorkerServer } from "@fluidframework/server-hack-local-server";

const sharedWorkerServer = new SharedWorkerServer();
console.log("SharedWorkerServer initialized:", sharedWorkerServer);
