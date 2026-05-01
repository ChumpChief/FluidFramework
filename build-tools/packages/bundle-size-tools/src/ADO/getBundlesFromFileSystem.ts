/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { promises as fsPromises } from "fs";
import { join } from "path";

import type { AnalyzerAssetEntry, Packages } from "../types";
import {
	type AnalyzerJsonByPackage,
	extractPackageSummaries,
	sourcePackageFromAnalyzerPath,
} from "./extractPackageSummaries";

/**
 * Gets the relative path of all files in this directory
 * @param sourceFolder - The path of the directory to scan
 * @param partialPathPrefix - The partial path built up as we recurse through directories. External callers probably don't want to set this.
 */
async function getAllFilesInDirectory(
	sourceFolder: string,
	partialPathPrefix: string = "",
): Promise<string[]> {
	const result: string[] = [];
	for (const file of await fsPromises.readdir(sourceFolder)) {
		const fullPath = join(sourceFolder, file);
		if ((await fsPromises.stat(fullPath)).isFile()) {
			result.push(join(partialPathPrefix, file));
		} else {
			result.push(
				...(await getAllFilesInDirectory(
					join(sourceFolder, file),
					join(partialPathPrefix, file),
				)),
			);
		}
	}
	return result;
}

/**
 * Walks `rootPath`, finds every `analyzer.json` file, parses it, and keys the
 * results by source package.
 */
async function extractAnalyzerJsonsFromFileSystem(
	rootPath: string,
): Promise<AnalyzerJsonByPackage> {
	const allPaths = await getAllFilesInDirectory(rootPath);
	const result: AnalyzerJsonByPackage = new Map();
	const reads: Promise<void>[] = [];
	for (const relativePath of allPaths) {
		const sourcePackage = sourcePackageFromAnalyzerPath(relativePath);
		if (sourcePackage === undefined) continue;
		reads.push(
			fsPromises.readFile(join(rootPath, relativePath), "utf8").then((text) => {
				result.set(sourcePackage, JSON.parse(text) as AnalyzerAssetEntry[]);
			}),
		);
	}
	await Promise.all(reads);
	return result;
}

/**
 * Reads analyzer.json files from a local bundle-report directory and returns
 * them as a {@link Packages}.
 */
export async function getBundlesFromFileSystem(rootPath: string): Promise<Packages> {
	const jsons = await extractAnalyzerJsonsFromFileSystem(rootPath);
	return extractPackageSummaries(jsons);
}
