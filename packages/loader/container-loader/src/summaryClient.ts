/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	LoaderHeader,
	type SummaryExecutionProvider,
} from "@fluidframework/container-definitions/internal";
import type { FluidObject, IRequest } from "@fluidframework/core-interfaces";
import { DriverHeader } from "@fluidframework/driver-definitions/internal";

import type { IContainerCreateProps } from "./container.js";

/** Loader-owned creation policy shared by relative cloning and host-triggered summary loading. */
export function summaryClientCreateProps(): Pick<
	IContainerCreateProps,
	"canReconnect" | "clientDetailsOverride"
> {
	return {
		canReconnect: false,
		clientDetailsOverride: {
			capabilities: { interactive: false },
			type: "summarizer",
		},
	};
}

/** Adapts the summary-client policy to the existing host loader request protocol. */
export function summaryClientRequest(request: IRequest): IRequest {
	const { canReconnect, clientDetailsOverride } = summaryClientCreateProps();
	return {
		...request,
		headers: {
			...request.headers,
			[LoaderHeader.cache]: false,
			[LoaderHeader.clientDetails]: clientDetailsOverride,
			[DriverHeader.summarizingClient]: true,
			[LoaderHeader.reconnect]: canReconnect,
		},
	};
}

/** Uses dedicated execution discovery when supported, otherwise the older entrypoint contract. */
export async function getSummaryExecution(
	provider: Partial<SummaryExecutionProvider> & { getEntryPoint(): Promise<FluidObject> },
): Promise<FluidObject | undefined> {
	return provider.getSummaryExecution === undefined
		? provider.getEntryPoint()
		: provider.getSummaryExecution();
}
