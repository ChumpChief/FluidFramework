/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ITrace } from "../protocol-definitions";

export interface IMetricClient {
    writeLatencyMetric(series: string, traces: ITrace[]): Promise<void>;
}

// Default client for loca run.
export class DefaultMetricClient implements IMetricClient {
    public async writeLatencyMetric(series: string, traces: ITrace[]): Promise<void> { }
}
