/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { AnalyzerAssetEntry, BundleSizeSet, PackageSummaries } from "../types";
import type { BundleFileData } from "./getBundleFilePathsFromFolder";

export interface GetBundleSummariesArgs {
	bundlePaths: BundleFileData[];

	getAnalyzerJson: (relativePath: string) => Promise<AnalyzerAssetEntry[]>;
}

function entriesToBundleSizeSet(entries: AnalyzerAssetEntry[]): BundleSizeSet {
	const result: BundleSizeSet = new Map();
	for (const entry of entries) {
		if (!entry.isAsset) continue;
		result.set(entry.label, {
			statSize: entry.statSize,
			parsedSize: entry.parsedSize,
			gzipSize: entry.gzipSize,
		});
	}
	return result;
}

export async function getBundleSummaries(
	args: GetBundleSummariesArgs,
): Promise<PackageSummaries> {
	const result: PackageSummaries = new Map();

	const pendingAsyncWork = args.bundlePaths.map(async (bundle) => {
		const entries = await args.getAnalyzerJson(bundle.relativePathToAnalyzerJson);
		result.set(bundle.sourcePackage, entriesToBundleSizeSet(entries));
	});

	await Promise.all(pendingAsyncWork);

	return result;
}
