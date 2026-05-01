/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * Map from source package name to its entrypoint bundle data.
 */
export type Packages = Map<string, Entrypoints>;

/**
 * Map from entrypoint name to its bundle data, for one source package.
 */
export type Entrypoints = Map<string, BundleData>;

/**
 * Data for a single bundle (webpack entrypoint), sourced from
 * webpack-bundle-analyzer's chart data.
 */
export interface BundleData {
	/**
	 * Sum of source-module sizes before tree-shaking and minification.
	 */
	statSize: number;
	/**
	 * Post-minification on-disk size — what's actually emitted to the bundle output.
	 */
	parsedSize: number;
	/**
	 * Estimated size after gzip compression — closest proxy for what users download.
	 */
	gzipSize: number;
}

/**
 * Comparison of all bundles produced by one source package against a baseline.
 *
 * Each entry in `bundles` represents a single webpack entrypoint. The shape encodes
 * three states via field presence:
 * - **pre-existing** (existed in both): both `base` and `compare` present
 * - **added** (only in PR): only `compare` present
 * - **removed** (only in baseline): only `base` present
 *
 * The producer is deliberately unopinionated: it emits raw sizes only. Consumers
 * compute deltas, percentages, and apply their own thresholds / regression rules.
 */
export interface PackageComparison {
	sourcePackage: string;

	bundles: {
		[key: string]: {
			base?: BundleData;
			compare?: BundleData;
		};
	};
}

/**
 * One top-level entry from webpack-bundle-analyzer's `analyzerMode: "json"` output.
 * Each entry corresponds to one emitted webpack asset (a JS bundle).
 *
 * `groups` (the recursive module-byte-attribution tree that powers the treemap)
 * is intentionally not modeled here — we only consume the per-asset sizes.
 */
export interface AnalyzerAssetEntry {
	label: string;
	isAsset: boolean;
	statSize: number;
	parsedSize: number;
	gzipSize: number;
}
