/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { WebApi } from "azure-devops-node-api";
import type { Build } from "azure-devops-node-api/interfaces/BuildInterfaces";

export interface GetBuildOptions {
	/** The ADO project name. */
	project: string;
	/** ADO build definitions to query. */
	definitions: number[];
	/** Optional set of tags that should be on the returned builds. */
	tagFilters?: string[];
	/** Upper limit on builds returned per definition. */
	maxBuildsPerDefinition?: number;
}

/**
 * Wrapper around the unwieldy positional signature of ADO's `getBuilds`.
 */
export async function getBuilds(
	adoConnection: WebApi,
	options: GetBuildOptions,
): Promise<Build[]> {
	const buildApi = await adoConnection.getBuildApi();

	return buildApi.getBuilds(
		options.project,
		options.definitions,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		options.tagFilters,
		undefined,
		undefined,
		undefined,
		options.maxBuildsPerDefinition,
	);
}
