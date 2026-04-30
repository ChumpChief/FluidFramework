/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { WebApi } from "azure-devops-node-api";
import {
	type Build,
	BuildResult,
	BuildStatus,
} from "azure-devops-node-api/interfaces/BuildInterfaces";

import type { PackageSummaries } from "../types";
import { getBundlesFromArtifact } from "./getBundlesFromArtifact";

// Upper bound on builds fetched when searching for one matching the base commit.
// ADO has no API to query builds by commit SHA, so this window size determines
// how stale a PR branch can be relative to the target branch and still find its
// merge-base build.
const recentBuildsToFetch = 100;

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
}

/**
 * Wrapper around the unwieldy positional signature of ADO's `getBuilds`.
 */
async function getRecentBuilds(
	adoConnection: WebApi,
	project: string,
	definitionId: number,
): Promise<Build[]> {
	const buildApi = await adoConnection.getBuildApi();
	return buildApi.getBuilds(
		project,
		[definitionId],
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		recentBuildsToFetch,
	);
}

/**
 * Searches `builds` for one whose `sourceVersion` matches `targetCommit` and
 * validates it: must have an id, be completed, and have succeeded.
 */
function findUsableBuild(
	builds: Build[],
	targetCommit: string,
): { kind: "found"; build: Build & { id: number } } | { kind: "error"; error: string } {
	const build = builds.find((b) => b.sourceVersion === targetCommit);

	if (build === undefined) {
		return { kind: "error", error: `No CI build found for base commit ${targetCommit}` };
	}

	if (build.id === undefined) {
		return { kind: "error", error: `Baseline build does not have a build id` };
	}

	if (build.status !== BuildStatus.Completed) {
		return { kind: "error", error: "Baseline build for this PR has not yet completed." };
	}

	if (build.result !== BuildResult.Succeeded) {
		return {
			kind: "error",
			error: "Baseline CI build failed, cannot generate bundle analysis at this time",
		};
	}

	return { kind: "found", build: build as Build & { id: number } };
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
	const builds = await getRecentBuilds(
		adoConnection,
		options.project,
		options.ciBuildDefinitionId,
	);

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
