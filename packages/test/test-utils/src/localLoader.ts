/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IContainer,
    ILoader,
    IFluidCodeDetails,
} from "@fluidframework/container-definitions";
import { IUrlResolver } from "@fluidframework/driver-definitions";
import { LocalResolver } from "@fluidframework/local-driver";

/**
 * Creates a detached Container and attaches it.
 * @param documentId - The documentId for the container.
 * @param source - The code details used to create the Container.
 * @param loader - The loader to use to initialize the container.
 * @param urlresolver - The url resolver to get the create new request from.
 */

export async function createAndAttachContainer(
    documentId: string,
    source: IFluidCodeDetails,
    loader: ILoader,
    urlResolver: IUrlResolver,
): Promise<IContainer> {
    const container = await loader.createDetachedContainer(source);
    const attachUrl = (urlResolver as LocalResolver).createCreateNewRequest(documentId);
    await container.attach(attachUrl);

    return container;
}
