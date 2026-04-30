/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

export interface BundleFileData {
	sourcePackage: string;

	relativePathToAnalyzerJson: string;
}

function getSourcePackageFromPath(relativePath: string): string {
	// Our artifacts are stored in the the format /<npm scope>/<package name>[/<bundle name>]/<file name>.
	// We want to use the npm scope + package name as the source package identifier.
	// The regex here normalized the slashes in the path names.
	const pathParts = relativePath.replace(/\\/g, "/").split("/");

	if (pathParts.length < 3) {
		throw Error(`Could not derive a source package from this path: ${relativePath}`);
	}
	pathParts.pop(); // Remove the filename

	return pathParts.join("/");
}

export function getBundleFilePathsFromFolder(
	relativePathsInFolder: string[],
): BundleFileData[] {
	const analyzerJsonPaths: BundleFileData[] = [];

	relativePathsInFolder.forEach((relativePath) => {
		if (relativePath.endsWith("analyzer.json")) {
			analyzerJsonPaths.push({
				sourcePackage: getSourcePackageFromPath(relativePath),
				relativePathToAnalyzerJson: relativePath,
			});
		}
	});

	return analyzerJsonPaths;
}
