/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { WebApi } from "azure-devops-node-api";
import type JSZip from "jszip";

import type { AnalyzerAssetEntry, Packages } from "../types";
import { downloadArtifact } from "./downloadArtifact";
import {
	type AnalyzerJsonByPackage,
	extractPackageSummaries,
	sourcePackageFromAnalyzerPath,
} from "./extractPackageSummaries";

/**
 * Walks `zip`, finds every `analyzer.json` entry, parses it, and keys the
 * results by source package.
 */
async function extractAnalyzerJsonsFromZip(zip: JSZip): Promise<AnalyzerJsonByPackage> {
	const result: AnalyzerJsonByPackage = new Map();
	const reads: Promise<void>[] = [];
	zip.forEach((relativePath, zipObject) => {
		const sourcePackage = sourcePackageFromAnalyzerPath(relativePath);
		if (sourcePackage === undefined) return;
		reads.push(
			zipObject.async("string").then((text) => {
				result.set(sourcePackage, JSON.parse(text) as AnalyzerAssetEntry[]);
			}),
		);
	});
	await Promise.all(reads);
	return result;
}

/**
 * Downloads an ADO build artifact and returns its analyzer.json files as a
 * {@link Packages}.
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
): Promise<Packages> {
	const zip = await downloadArtifact(adoConnection, project, buildId, artifactName);
	const jsons = await extractAnalyzerJsonsFromZip(zip);
	return extractPackageSummaries(jsons);
}
