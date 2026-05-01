/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { execSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	compareBundles,
	getBundlesForCommit,
	getBundlesFromFileSystem,
	type PackageComparison,
} from "@fluidframework/bundle-size-tools";
import { Flags } from "@oclif/core";

import { getAzureDevopsApi } from "../../library/azureDevops/getAzureDevopsApi.js";
import { BaseCommand } from "../../library/commands/base.js";

// ADO constants for the baseline build source.
// Must match the "public" project + build-bundle-size-artifacts.yml (definitionId 48).
const adoConstants = {
	orgUrl: "https://dev.azure.com/fluidframework",
	projectName: "public",
	ciBuildDefinitionId: 48,
	bundleAnalysisArtifactName: "bundleAnalysis",
} as const;

// Default path to the PR's locally-collected bundle reports.
// Matches where `flub generate bundleStats` (invoked via `npm run bundle-analysis:collect`) writes.
const defaultLocalReportPath = "./artifacts/bundleAnalysis";

// Default output directory. The pipeline publishes this directory as the `bundleSizeDiff`
// artifact.
const defaultOutputDir = "./artifacts/bundleSizeDiff";

// Output file names. Only one of these is present per run: `result.json` when the
// comparison produced a meaningful result, or `error.json` when it did not. Consumers
// use file existence as the success/failure discriminator without needing to parse JSON.
const resultFileName = "result.json";
const errorFileName = "error.json";

/**
 * Provenance fields written to both `result.json` and `error.json` so consumers can
 * tell where the data came from and reason about freshness.
 */
interface BundleSizeDiffProvenance {
	prNumber: number;
	targetBranch: string;
	compareCommit: string;
	adoBuildId: number;
	timestamp: string;
}

/**
 * Shape of the `result.json` file produced on a successful comparison. `comparison`
 * holds the per-package diff data; each bundle entry encodes pre-existing / added /
 * removed via field presence (see {@link PackageComparison}). The producer is
 * unopinionated about what constitutes a "change" — consumers apply their own
 * thresholds.
 */
interface BundleSizeDiffResult extends BundleSizeDiffProvenance {
	baseCommit: string;
	comparison: PackageComparison[];
}

/**
 * Shape of the `error.json` file produced when the command could not produce a comparison
 * (e.g. no usable baseline build, an unexpected ADO API failure). `baseCommit` may be
 * `undefined` if the baseline search never reached a candidate.
 */
interface BundleSizeDiffError extends BundleSizeDiffProvenance {
	baseCommit: string | undefined;
	error: string;
}

export default class GenerateBundleSizeDiff extends BaseCommand<
	typeof GenerateBundleSizeDiff
> {
	static readonly description =
		`Compare the PR's locally-collected bundle reports against the CI build of the merge-base commit (the commit on the target branch the PR is based on) and write the outcome as one of two structured files in the output directory: result.json on success, error.json on failure.`;

	static readonly enableJsonFlag = true;

	static readonly flags = {
		localReportPath: Flags.directory({
			description: `Path to the locally-collected bundle reports for the PR (as produced by \`flub generate bundleStats\`).`,
			default: defaultLocalReportPath,
			required: false,
		}),
		outputDir: Flags.directory({
			description: `Directory to write result.json or error.json into.`,
			default: defaultOutputDir,
			required: false,
		}),
		// Hidden flags carrying CI context. Populated from env vars when running in the
		// pipeline; can be passed directly for local testing.
		targetBranch: Flags.string({
			description: "Name of the target branch the PR will merge into.",
			env: "TARGET_BRANCH",
			required: true,
			hidden: true,
		}),
		prNumber: Flags.integer({
			description: "GitHub PR number being analyzed.",
			env: "PR_NUMBER",
			required: true,
			hidden: true,
		}),
		compareCommit: Flags.string({
			description: "SHA of the PR branch's head commit being analyzed.",
			env: "COMPARE_COMMIT",
			required: true,
			hidden: true,
		}),
		adoBuildId: Flags.integer({
			description: "ID of the ADO pipeline build that produced this artifact.",
			env: "ADO_BUILD_ID",
			required: true,
			hidden: true,
		}),
		adoApiToken: Flags.string({
			description:
				"ADO PAT for accessing the baseline build. When absent, anonymous reads are used (suitable for fork PR builds where $(System.AccessToken) isn't populated).",
			env: "ADO_API_TOKEN",
			required: false,
			hidden: true,
		}),
		...BaseCommand.flags,
	} as const;

	public async run(): Promise<BundleSizeDiffResult | BundleSizeDiffError> {
		const {
			adoApiToken,
			adoBuildId,
			compareCommit,
			localReportPath,
			outputDir,
			prNumber,
			targetBranch,
		} = this.flags;

		const provenance: BundleSizeDiffProvenance = {
			prNumber,
			targetBranch,
			compareCommit,
			adoBuildId,
			timestamp: new Date().toISOString(),
		};

		const resolvedOutputDir = path.resolve(process.cwd(), outputDir);
		await mkdir(resolvedOutputDir, { recursive: true });
		const resultPath = path.join(resolvedOutputDir, resultFileName);
		const errorPath = path.join(resolvedOutputDir, errorFileName);

		// Clear any prior output files so consumers can rely on file existence as the
		// success/failure discriminator without worrying about stale artifacts from earlier runs.
		await Promise.all([rm(resultPath, { force: true }), rm(errorPath, { force: true })]);

		const writeError = async (
			error: string,
			baseCommit: string | undefined,
		): Promise<BundleSizeDiffError> => {
			const errorResult: BundleSizeDiffError = { ...provenance, baseCommit, error };
			await writeFile(errorPath, JSON.stringify(errorResult, undefined, 2));
			this.info(`Wrote ${errorPath} — ${error}`);
			return errorResult;
		};

		let baseCommit: string | undefined;
		try {
			baseCommit = execSync(`git merge-base origin/${targetBranch} HEAD`).toString().trim();
			console.log(`The base commit for this PR is ${baseCommit}`);

			const adoConnection = getAzureDevopsApi(adoApiToken, adoConstants.orgUrl);

			const [baselineLookup, comparePackages] = await Promise.all([
				getBundlesForCommit(adoConnection, {
					project: adoConstants.projectName,
					ciBuildDefinitionId: adoConstants.ciBuildDefinitionId,
					artifactName: adoConstants.bundleAnalysisArtifactName,
					baseCommit,
				}),
				getBundlesFromFileSystem(localReportPath),
			]);

			if (baselineLookup.kind === "error") {
				return await writeError(baselineLookup.error, baseCommit);
			}

			const { basePackages } = baselineLookup;
			if (basePackages.size === 0 || comparePackages.size === 0) {
				return await writeError(
					"No bundles to compare — baseline artifact or PR local bundle reports are empty.",
					baseCommit,
				);
			}

			const comparison = compareBundles(basePackages, comparePackages);
			const result: BundleSizeDiffResult = { ...provenance, baseCommit, comparison };

			await writeFile(resultPath, JSON.stringify(result, undefined, 2));
			this.info(`Wrote ${resultPath} (base ${baseCommit})`);
			return result;
		} catch (e) {
			return writeError(
				`Unexpected failure during size comparison: ${e instanceof Error ? e.message : String(e)}`,
				baseCommit,
			);
		}
	}
}
