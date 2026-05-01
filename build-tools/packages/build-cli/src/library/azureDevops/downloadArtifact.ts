/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import type { WebApi } from "azure-devops-node-api";
import { unzipSync } from "fflate";

/**
 * Files extracted from an ADO pipeline artifact zip, keyed by path relative
 * to the artifact's top-level folder.
 */
export type ArtifactContents = { [path: string]: Uint8Array };

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("close", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}

/**
 * Downloads an Azure DevOps pipeline artifact and returns its files as
 * an {@link ArtifactContents}.
 *
 * @param adoApi - A connection to the ADO API.
 * @param project - The ADO project containing the build.
 * @param buildId - The numeric build id whose artifact to fetch.
 * @param artifactName - The pipeline artifact's published name.
 */
export async function downloadArtifact(
	adoApi: WebApi,
	project: string,
	buildId: number,
	artifactName: string,
): Promise<ArtifactContents> {
	const buildApi = await adoApi.getBuildApi();

	// IMPORTANT
	// getArtifactContentZip() in the azure-devops-node-api package tries to download pipeline artifacts using an
	// API version (in the http request's accept header) that isn't supported by the artifact download endpoint.
	// One way of getting around that is by temporarily removing the API version that the package adds, to force
	// it to use a supported one.
	// See https://github.com/microsoft/azure-devops-node-api/issues/432 for more details.
	const originalCreateAcceptHeader = buildApi.createAcceptHeader;
	buildApi.createAcceptHeader = (type: string): string => type;
	const artifactStream = await buildApi.getArtifactContentZip(project, buildId, artifactName);
	// Undo hack from above
	buildApi.createAcceptHeader = originalCreateAcceptHeader;

	const buffer = await readStreamToBuffer(artifactStream);
	const entries = unzipSync(buffer);

	// Scope to entries inside the artifact's top-level folder, with the prefix
	// stripped from each key so callers see clean relative paths.
	const prefix = `${artifactName}/`;
	const result: ArtifactContents = {};
	for (const [path, bytes] of Object.entries(entries)) {
		if (path.startsWith(prefix)) {
			result[path.slice(prefix.length)] = bytes;
		}
	}

	assert(
		Object.keys(result).length > 0,
		`downloadArtifact could not find the folder ${artifactName}`,
	);

	return result;
}
