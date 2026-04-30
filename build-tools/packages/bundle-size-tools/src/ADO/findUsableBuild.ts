/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	type Build,
	BuildResult,
	BuildStatus,
} from "azure-devops-node-api/interfaces/BuildInterfaces";

/**
 * Result of looking up a usable build for a target commit.
 */
export type FindUsableBuildResult =
	| { kind: "found"; build: Build & { id: number } }
	| { kind: "error"; error: string };

/**
 * Searches `builds` for one whose `sourceVersion` matches `targetCommit` and
 * validates it: must have an id, be completed, and have succeeded.
 *
 * Pure function — no side effects, no I/O.
 */
export function findUsableBuild(builds: Build[], targetCommit: string): FindUsableBuildResult {
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
