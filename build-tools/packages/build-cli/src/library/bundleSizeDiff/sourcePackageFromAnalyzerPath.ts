/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

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
