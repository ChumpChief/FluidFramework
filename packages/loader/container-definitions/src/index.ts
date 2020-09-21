/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IProvideRuntimeFactory } from "./runtime";

declare module "@fluidframework/core-interfaces" {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    export interface IFluidObject extends Readonly<Partial<
        IProvideRuntimeFactory>> { }
}

export * from "./audience";
export * from "./deltas";
export * from "./error";
export * from "./fluidPackage";
export * from "./runtime";
