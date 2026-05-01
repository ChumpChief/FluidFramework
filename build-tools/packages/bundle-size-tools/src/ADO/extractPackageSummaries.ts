/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { AnalyzerAssetEntry, Entrypoints, Packages } from "../types";

/**
 * Map from source package name to the analyzer.json contents (as parsed
 * webpack-bundle-analyzer chart entries) that source package produced.
 */
export type AnalyzerJsonByPackage = Map<string, AnalyzerAssetEntry[]>;

const analyzerJsonFileName = "analyzer.json";

/**
 * If `relativePath` looks like `<scope>/<package>[/<subdir>]/analyzer.json`,
 * returns the source-package portion (everything before the filename). Returns
 * `undefined` for paths that aren't an analyzer.json or don't have at least
 * one directory component.
 *
 * Slashes are normalized first so the same logic handles both Windows and
 * POSIX path separators.
 */
export function sourcePackageFromAnalyzerPath(relativePath: string): string | undefined {
	const pathParts = relativePath.replace(/\\/g, "/").split("/");
	const fileName = pathParts.pop();
	if (fileName !== analyzerJsonFileName) return undefined;
	if (pathParts.length < 2) return undefined;
	return pathParts.join("/");
}

/**
 * Convert parsed analyzer.json contents (one per source package) into a
 * {@link Packages} keyed by source package, where each value maps
 * entrypoint name to its bundle data.
 */
export function extractPackageSummaries(jsons: AnalyzerJsonByPackage): Packages {
	const result: Packages = new Map();
	for (const [sourcePackage, entries] of jsons) {
		const sizes: Entrypoints = new Map();
		for (const entry of entries) {
			if (!entry.isAsset) continue;
			sizes.set(entry.label, {
				statSize: entry.statSize,
				parsedSize: entry.parsedSize,
				gzipSize: entry.gzipSize,
			});
		}
		result.set(sourcePackage, sizes);
	}
	return result;
}
