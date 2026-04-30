/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { PackageComparison, PackageSummaries } from "./types";

/**
 * Compares all the bundle summaries for a "base" and a "compare" set, grouped by
 * source package. Iterates the union of source packages and bundles so added and
 * removed entries are explicitly represented (see {@link PackageComparison}).
 */
export function compareBundles(
	base: PackageSummaries,
	compare: PackageSummaries,
): PackageComparison[] {
	const results: PackageComparison[] = [];

	const allPackages = new Set<string>([...base.keys(), ...compare.keys()]);

	for (const sourcePackage of allPackages) {
		const baseBundles = base.get(sourcePackage);
		const compareBundles = compare.get(sourcePackage);

		const allBundleNames = new Set<string>([
			...(baseBundles?.keys() ?? []),
			...(compareBundles?.keys() ?? []),
		]);

		const bundles: PackageComparison["bundles"] = {};
		for (const bundleName of allBundleNames) {
			const baseBundle = baseBundles?.get(bundleName);
			const compareBundle = compareBundles?.get(bundleName);

			bundles[bundleName] = {
				...(baseBundle && { base: baseBundle }),
				...(compareBundle && { compare: compareBundle }),
			};
		}

		results.push({ sourcePackage, bundles });
	}

	return results;
}
