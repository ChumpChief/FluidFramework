/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { BundlesComparison, PackageComparison, Packages } from "./types";

/**
 * Compares all the bundle data for a "base" and a "compare" set, grouped by
 * source package. Iterates the union of source packages and bundles so added and
 * removed entries are explicitly represented (see {@link PackageComparison}).
 */
export function compareBundleSizes(base: Packages, compare: Packages): PackageComparison {
	const result: PackageComparison = {};

	const allPackages = new Set<string>([...base.keys(), ...compare.keys()]);

	for (const sourcePackage of allPackages) {
		const baseEntrypoints = base.get(sourcePackage);
		const compareEntrypoints = compare.get(sourcePackage);

		const allBundleNames = new Set<string>([
			...(baseEntrypoints?.keys() ?? []),
			...(compareEntrypoints?.keys() ?? []),
		]);

		const bundles: BundlesComparison = {};
		for (const bundleName of allBundleNames) {
			const baseBundle = baseEntrypoints?.get(bundleName);
			const compareBundle = compareEntrypoints?.get(bundleName);

			bundles[bundleName] = {
				...(baseBundle && { base: baseBundle }),
				...(compareBundle && { compare: compareBundle }),
			};
		}

		result[sourcePackage] = bundles;
	}

	return result;
}
