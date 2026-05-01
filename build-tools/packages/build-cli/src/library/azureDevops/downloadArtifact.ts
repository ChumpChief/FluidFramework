/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import type { WebApi } from "azure-devops-node-api";
import jszip, { type default as JSZip } from "jszip";

async function unzipStream(stream: NodeJS.ReadableStream): Promise<JSZip> {
	const buffer = await new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("close", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
	return jszip.loadAsync(buffer);
}

/**
 * Downloads an Azure DevOps pipeline artifact and returns its contents as a JSZip.
 *
 * @param adoConnection - A connection to the ADO API.
 * @param project - The ADO project containing the build.
 * @param buildId - The numeric build id whose artifact to fetch.
 * @param artifactName - The pipeline artifact's published name.
 */
export async function downloadArtifact(
	adoConnection: WebApi,
	project: string,
	buildId: number,
	artifactName: string,
): Promise<JSZip> {
	const buildApi = await adoConnection.getBuildApi();

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

	// We want our relative paths to be clean, so navigating JsZip into the top level folder
	const result = (await unzipStream(artifactStream)).folder(artifactName);
	assert(result, `downloadArtifact could not find the folder ${artifactName}`);

	return result;
}
