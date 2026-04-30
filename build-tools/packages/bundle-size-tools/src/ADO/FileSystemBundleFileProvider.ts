/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { promises as fsPromises } from "fs";
import { join } from "path";

import type { AnalyzerAssetEntry } from "../types";
import {
	type BundleFileData,
	getBundleFilePathsFromFolder,
} from "./getBundleFilePathsFromFolder";

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
 * Returns a list of all the files relevant to bundle buddy from the given folder
 * @param bundleReportPath - The path to the folder containing the bundle report
 */
export async function getBundlePathsFromFileSystem(
	bundleReportPath: string,
): Promise<BundleFileData[]> {
	const filePaths = await getAllFilesInDirectory(bundleReportPath);

	return getBundleFilePathsFromFolder(filePaths);
}

/**
 * Gets and parses an analyzer.json from the filesystem.
 * @param path - the full path to the file in the filesystem
 */
export async function getAnalyzerJsonFromFileSystem(
	path: string,
): Promise<AnalyzerAssetEntry[]> {
	const file = await fsPromises.readFile(path, "utf8");

	return JSON.parse(file);
}
