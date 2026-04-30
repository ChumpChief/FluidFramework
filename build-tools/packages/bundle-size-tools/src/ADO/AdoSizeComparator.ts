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
import { execSync } from "child_process";
import type JSZip from "jszip";
import { join } from "path";
import { compareBundles } from "../compareBundles";
import type { PackageComparison } from "../types";
import {
	getAnalyzerJsonFromZip,
	getBundlePathsFromZipObject,
	getZipObjectFromArtifact,
} from "./AdoArtifactFileProvider";
import {
	getAnalyzerJsonFromFileSystem,
	getBundlePathsFromFileSystem,
} from "./FileSystemBundleFileProvider";
import { getBundleSummaries } from "./getBundleSummaries";

export interface IADOConstants {
	// URL for the ADO org
	orgUrl: string;

	// The ADO project that contains the repo
	projectName: string;

	// The ID for the build that runs against main when PRs are merged
	ciBuildDefinitionId: number;

	// The name of the build artifact that contains the bundle size artifacts
	bundleAnalysisArtifactName: string;

	// The number of most recent ADO builds to pull when searching for one associated
	// with a specific commit, default 20.  Pulling more builds takes longer, but may
	// be useful when there are a high volume of commits/builds.
	buildsToSearch?: number;
}

/**
 * Gets the commit on the target branch that the current branch is based on.
 * @param targetBranch - The name of the target branch (e.g., "main").
 */
function getBaseCommit(targetBranch: string): string {
	return execSync(`git merge-base origin/${targetBranch} HEAD`).toString().trim();
}

interface GetBuildOptions {
	// The ADO project name
	project: string;

	// An array of ADO definitions that should be considered for this query
	definitions: number[];

	// An optional set of tags that should be on the returned builds
	tagFilters?: string[];

	// An upper limit on the number of queries to return. Can be used to improve performance
	maxBuildsPerDefinition?: number;
}

/**
 * A wrapper around the terrible API signature for ADO getBuilds
 */
async function getBuilds(adoConnection: WebApi, options: GetBuildOptions): Promise<Build[]> {
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

/**
 * Result of a size comparison against a baseline build, discriminated by `kind`.
 *
 * On `"success"`, `comparison` holds the bundle diff against `baseCommit`.
 * On `"error"`, the comparison could not be produced and `error` holds the reason;
 * `baseCommit` reflects the last commit that was attempted and may be `undefined`
 * if the search never found a candidate.
 */
export type SizeComparison =
	| { kind: "success"; baseCommit: string; comparison: PackageComparison[] }
	| { kind: "error"; baseCommit: string | undefined; error: string };

export class ADOSizeComparator {
	/**
	 * The default number of most recent builds on the ADO pipeline to search when
	 * looking for a build matching a base commit.
	 */
	private static readonly defaultBuildsToSearch = 100;

	constructor(
		/**
		 * ADO constants identifying where to fetch baseline bundle info
		 */
		private readonly adoConstants: IADOConstants,
		/**
		 * The ADO connection to use to fetch baseline bundle info
		 */
		private readonly adoConnection: WebApi,
		/**
		 * Path to existing local bundle size reports
		 */
		private readonly localReportPath: string,
		/**
		 * Name of the target branch the current branch will merge into. Used to compute
		 * the baseline commit (`git merge-base origin/<targetBranch> HEAD`).
		 */
		private readonly targetBranch: string,
	) {}

	/**
	 * Run the bundle size comparison against the baseline build.
	 *
	 * @returns A {@link SizeComparison} tagged with `kind: "success"` or `kind: "error"`.
	 * Never throws: unexpected exceptions from underlying `git` shell-outs, ADO API
	 * calls, or stats-file parsing are caught and reported via the `error` variant so
	 * callers can rely on the return shape.
	 */
	public async getSizeComparison(): Promise<SizeComparison> {
		// Declared outside the try block so the catch can still report the last-known
		// commit value in the synthesized error variant.
		let baseCommit: string | undefined;
		try {
			baseCommit = getBaseCommit(this.targetBranch);
			console.log(`The base commit for this PR is ${baseCommit}`);

			const recentBuilds = await getBuilds(this.adoConnection, {
				project: this.adoConstants.projectName,
				definitions: [this.adoConstants.ciBuildDefinitionId],
				maxBuildsPerDefinition:
					this.adoConstants.buildsToSearch ?? ADOSizeComparator.defaultBuildsToSearch,
			});

			const baseBuild = recentBuilds.find((build) => build.sourceVersion === baseCommit);

			if (baseBuild === undefined) {
				return {
					kind: "error",
					baseCommit,
					error: `No CI build found for base commit ${baseCommit}`,
				};
			}

			if (baseBuild.id === undefined) {
				return {
					kind: "error",
					baseCommit,
					error: `Baseline build does not have a build id`,
				};
			}

			if (baseBuild.status !== BuildStatus.Completed) {
				return {
					kind: "error",
					baseCommit,
					error: "Baseline build for this PR has not yet completed.",
				};
			}

			if (baseBuild.result !== BuildResult.Succeeded) {
				return {
					kind: "error",
					baseCommit,
					error: "Baseline CI build failed, cannot generate bundle analysis at this time",
				};
			}

			console.log(`Found baseline build with id: ${baseBuild.id}`);

			const baseZip = await getZipObjectFromArtifact(
				this.adoConnection,
				this.adoConstants.projectName,
				baseBuild.id,
				this.adoConstants.bundleAnalysisArtifactName,
			).catch((error) => {
				console.log(`Error unzipping object from artifact: ${error.message}`);
				console.log(`Error stack: ${error.stack}`);
				return undefined;
			});

			if (baseZip === undefined) {
				return {
					kind: "error",
					baseCommit,
					error: `Baseline build for commit ${baseCommit} did not publish bundle artifacts`,
				};
			}

			const comparison: PackageComparison[] = await this.createComparisonFromZip(baseZip);

			return { kind: "success", baseCommit, comparison };
		} catch (e) {
			return {
				kind: "error",
				baseCommit,
				error: `Unexpected failure during size comparison: ${
					e instanceof Error ? e.message : String(e)
				}`,
			};
		}
	}

	private async createComparisonFromZip(baseZip: JSZip): Promise<PackageComparison[]> {
		const baseZipBundlePaths = getBundlePathsFromZipObject(baseZip);

		const prBundleFileSystemPaths = await getBundlePathsFromFileSystem(this.localReportPath);

		const baseSummaries = await getBundleSummaries({
			bundlePaths: baseZipBundlePaths,
			getAnalyzerJson: (relativePath) => getAnalyzerJsonFromZip(baseZip, relativePath),
		});

		const prSummaries = await getBundleSummaries({
			bundlePaths: prBundleFileSystemPaths,
			getAnalyzerJson: (relativePath) =>
				getAnalyzerJsonFromFileSystem(join(this.localReportPath, relativePath)),
		});

		return compareBundles(baseSummaries, prSummaries);
	}
}
