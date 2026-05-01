/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { WebApi } from "azure-devops-node-api";
import {
	type Build,
	BuildResult,
	BuildStatus,
} from "azure-devops-node-api/interfaces/BuildInterfaces.js";

import { type ArtifactContents, downloadArtifact } from "./downloadArtifact.js";

// Upper bound on builds fetched when searching for one matching a target commit.
// ADO has no API to query builds by commit SHA, so this window size determines
// how stale a target commit can be relative to the pipeline's recent activity
// and still be findable.
const recentBuildsToFetch = 100;

/**
 * Result of looking up an artifact for a target commit on an ADO pipeline.
 */
export type ArtifactForCommitResult =
	| { kind: "found"; contents: ArtifactContents }
	| { kind: "error"; error: string };

export interface GetArtifactForCommitOptions {
	/** The ADO project name. */
	project: string;
	/** ID of the ADO pipeline whose builds to search. */
	definitionId: number;
	/** Name of the pipeline artifact to fetch. */
	artifactName: string;
	/** Commit whose build to look up. */
	commit: string;
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
 * Looks up the build for `commit` in `builds` and validates that it has an id,
 * is completed, and succeeded. Returns the build id on success, or a
 * human-readable error explaining why no usable build was found.
 */
function findBuildIdForCommit(
	builds: Build[],
	commit: string,
): { kind: "found"; buildId: number } | { kind: "error"; error: string } {
	const build = builds.find((b) => b.sourceVersion === commit);

	if (build === undefined) {
		return { kind: "error", error: `No build found for commit ${commit}` };
	}

	if (build.id === undefined) {
		return { kind: "error", error: `Build for commit ${commit} does not have a build id` };
	}

	if (build.status !== BuildStatus.Completed) {
		return { kind: "error", error: `Build for commit ${commit} has not yet completed.` };
	}

	if (build.result !== BuildResult.Succeeded) {
		return {
			kind: "error",
			error: `Build for commit ${commit} did not succeed.`,
		};
	}

	return { kind: "found", buildId: build.id };
}

/**
 * Look up the build for `commit` on the given ADO pipeline and return the
 * contents of one of its artifacts. Returns a discriminated union: on success,
 * the artifact's {@link ArtifactContents}; on failure, a human-readable error
 * string covering missing/incomplete/failed builds and missing artifacts.
 */
export async function getArtifactForCommit(
	adoConnection: WebApi,
	options: GetArtifactForCommitOptions,
): Promise<ArtifactForCommitResult> {
	const builds = await getRecentBuilds(adoConnection, options.project, options.definitionId);

	const buildLookup = findBuildIdForCommit(builds, options.commit);
	if (buildLookup.kind === "error") {
		return buildLookup;
	}

	try {
		const contents = await downloadArtifact(
			adoConnection,
			options.project,
			buildLookup.buildId,
			options.artifactName,
		);
		return { kind: "found", contents };
	} catch (e) {
		return {
			kind: "error",
			error: `Build for commit ${options.commit} did not publish artifact "${options.artifactName}": ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}
