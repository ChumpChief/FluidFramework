/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { INackContent, NackErrorType } from "../protocol-definitions";

export class ThrottlingError implements INackContent {
    readonly code = 429;
    readonly type = NackErrorType.ThrottlingError;

    constructor(
        /**
         * Explanation for throttling.
         */
        readonly message: string,
        /**
         * Client should retry operation after this many seconds.
         */
        readonly retryAfter: number,
    ) {
    }
}

/**
 * Determines if an operation should be allowed or throttled.
 */
export interface IThrottler {
    /**
     * Increment the current processing count of operations by `weight`.
     * @throws {ThrottlingError} when throttled.
     */
    incrementCount(id: string, weight?: number): void;

    /**
     * Decrement the current processing count of operations by `weight`.
     */
    decrementCount(id: string, weight?: number): void;
}
