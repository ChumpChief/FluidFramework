/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { WebApi } from "azure-devops-node-api";
import type { BundleAnalyzerPlugin } from "webpack-bundle-analyzer";

import { type ArtifactContents, downloadArtifact } from "../azureDevops/downloadArtifact.js";
import { sourcePackageFromAnalyzerPath } from "./sourcePackageFromAnalyzerPath.js";
import type { AnalyzerJsonByPackage } from "./types.js";

/**
 * Walks `entries`, finds every `analyzer.json`, parses it, and keys the
 * results by source package.
 */
function extractAnalyzerJsons(entries: ArtifactContents): AnalyzerJsonByPackage {
	const result: AnalyzerJsonByPackage = new Map();
	for (const [relativePath, bytes] of Object.entries(entries)) {
		const sourcePackage = sourcePackageFromAnalyzerPath(relativePath);
		if (sourcePackage === undefined) continue;
		const text = Buffer.from(bytes).toString("utf8");
		result.set(sourcePackage, JSON.parse(text) as BundleAnalyzerPlugin.JsonReport);
	}
	return result;
}

/**
 * Downloads an ADO build artifact and returns its analyzer.json files as an
 * {@link AnalyzerJsonByPackage}.
 *
 * @param adoConnection - A connection to the ADO API.
 * @param project - The ADO project containing the build.
 * @param buildId - The numeric build id whose artifact to fetch.
 * @param artifactName - The pipeline artifact's published name.
 */
export async function getBundlesFromArtifact(
	adoConnection: WebApi,
	project: string,
	buildId: number,
	artifactName: string,
): Promise<AnalyzerJsonByPackage> {
	const entries = await downloadArtifact(adoConnection, project, buildId, artifactName);
	return extractAnalyzerJsons(entries);
}
