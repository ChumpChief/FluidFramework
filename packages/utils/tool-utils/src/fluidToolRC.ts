/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/* eslint-disable unicorn/filename-case */

import os from "os";
import path from "path";
import { lock } from "proper-lockfile";

export interface IAsyncCache<TKey, TValue> {
    get(key: TKey): Promise<TValue | undefined>;
    save(key: TKey, value: TValue): Promise<void>;
    lock<T>(callback: () => Promise<T>): Promise<T>;
}

const getRCFileName = () => path.join(os.homedir(), ".fluidtoolrc");

// eslint-disable-next-line prefer-arrow/prefer-arrow-functions
export async function lockRC() {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return lock(getRCFileName(), {
        retries: {
            forever: true,
        },
        realpath: false,
    });
}
