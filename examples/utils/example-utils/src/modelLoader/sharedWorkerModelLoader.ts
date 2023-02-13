/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ICodeDetailsLoader } from "@fluidframework/container-definitions";
import {
	createLocalResolverCreateNewRequest,
	LocalResolver,
	SharedWorkerDocumentServiceFactory,
} from "@fluidframework/hack-local-driver";
import { IModelLoader } from "./interfaces";
import { ModelLoader } from "./modelLoader";

const urlResolver = new LocalResolver();
const documentServiceFactory = new SharedWorkerDocumentServiceFactory();

export class SharedWorkerModelLoader<ModelType> implements IModelLoader<ModelType> {
	private readonly modelLoader = new ModelLoader<ModelType>({
		urlResolver,
		documentServiceFactory,
		codeLoader: this.codeLoader,
		generateCreateNewRequest: createLocalResolverCreateNewRequest,
	});
	public constructor(private readonly codeLoader: ICodeDetailsLoader) {}

	public async supportsVersion(version: string): Promise<boolean> {
		return this.modelLoader.supportsVersion(version);
	}

	public async createDetached(version: string) {
		return this.modelLoader.createDetached(version);
	}
	public async loadExisting(id: string) {
		return this.modelLoader.loadExisting(`${window.location.origin}/${id}`);
	}
}
