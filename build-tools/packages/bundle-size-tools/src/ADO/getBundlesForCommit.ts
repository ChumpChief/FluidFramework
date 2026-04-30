/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { WebApi } from "azure-devops-node-api";

import type { PackageSummaries } from "../types";
import { findUsableBuild } from "./findUsableBuild";
import { getBuilds } from "./getBuilds";
import { getBundlesFromArtifact } from "./getBundlesFromArtifact";

const defaultMaxBuildsPerDefinition = 100;

/**
 * Result of looking up bundle data for a target commit on an ADO baseline pipeline.
 */
export type BaselineBundlesResult =
	| { kind: "found"; baseBundles: PackageSummaries }
	| { kind: "error"; error: string };

export interface GetBundlesForCommitOptions {
	/** The ADO project name. */
	project: string;
	/** ID of the ADO baseline build pipeline. */
	ciBuildDefinitionId: number;
	/** Name of the pipeline artifact containing the bundle reports. */
	artifactName: string;
	/** Commit whose baseline build to look up. */
	baseCommit: string;
	/** Upper limit on builds returned when searching. Default 100. */
	maxBuildsPerDefinition?: number;
}

/**
 * Look up the baseline build for `baseCommit` on the given ADO pipeline and
 * return its bundle data. Returns a discriminated union: on success, the
 * `PackageSummaries` for the baseline build; on failure, a human-readable
 * error string covering missing/incomplete/failed builds and missing artifacts.
 */
export async function getBundlesForCommit(
	adoConnection: WebApi,
	options: GetBundlesForCommitOptions,
): Promise<BaselineBundlesResult> {
	const builds = await getBuilds(adoConnection, {
		project: options.project,
		definitions: [options.ciBuildDefinitionId],
		maxBuildsPerDefinition: options.maxBuildsPerDefinition ?? defaultMaxBuildsPerDefinition,
	});

	const buildLookup = findUsableBuild(builds, options.baseCommit);
	if (buildLookup.kind === "error") {
		return buildLookup;
	}

	try {
		const baseBundles = await getBundlesFromArtifact(
			adoConnection,
			options.project,
			buildLookup.build.id,
			options.artifactName,
		);
		return { kind: "found", baseBundles };
	} catch (e) {
		return {
			kind: "error",
			error: `Baseline build for commit ${options.baseCommit} did not publish bundle artifacts: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}
