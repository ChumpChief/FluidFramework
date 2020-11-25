/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { parse } from "url";
import {
    IDocumentServiceFactory,
    IDocumentService,
    IFluidResolvedUrl,
} from "@fluidframework/driver-definitions";
import { ISummaryTree } from "@fluidframework/protocol-definitions";
import { ITelemetryBaseLogger } from "@fluidframework/common-definitions";

export class MultiDocumentServiceFactory implements IDocumentServiceFactory {
    public static create(documentServiceFactory: IDocumentServiceFactory | IDocumentServiceFactory[]) {
        if (Array.isArray(documentServiceFactory)) {
            const factories: IDocumentServiceFactory[] = [];
            documentServiceFactory.forEach((factory) => {
                const maybeMulti = factory as MultiDocumentServiceFactory;
                if (maybeMulti.protocolToDocumentFactoryMap !== undefined) {
                    factories.push(...maybeMulti.protocolToDocumentFactoryMap.values());
                } else {
                    factories.push(factory);
                }
            });
            if (factories.length === 1) {
                return factories[0];
            }
            return new MultiDocumentServiceFactory(factories);
        }
        return documentServiceFactory;
    }

    private readonly protocolToDocumentFactoryMap: Map<string, IDocumentServiceFactory>;

    constructor(documentServiceFactories: IDocumentServiceFactory[]) {
        this.protocolToDocumentFactoryMap = new Map();
        documentServiceFactories.forEach((factory: IDocumentServiceFactory) => {
            this.protocolToDocumentFactoryMap.set(factory.protocolName, factory);
        });
    }
    public readonly protocolName = "none:";
    async createDocumentService(
        fluidResolvedUrl: IFluidResolvedUrl,
        logger?: ITelemetryBaseLogger,
    ): Promise<IDocumentService> {
        const urlObj = parse(fluidResolvedUrl.url);
        if (urlObj.protocol === undefined) {
            throw new Error("No protocol provided");
        }
        const factory: IDocumentServiceFactory | undefined = this.protocolToDocumentFactoryMap.get(urlObj.protocol);
        if (factory === undefined) {
            throw new Error("Unknown Fluid protocol");
        }

        return factory.createDocumentService(fluidResolvedUrl, logger);
    }

    public async createContainer(
        createNewSummary: ISummaryTree,
        createNewResolvedUrl: IFluidResolvedUrl,
        logger?: ITelemetryBaseLogger,
    ): Promise<IDocumentService> {
        const urlObj = parse(createNewResolvedUrl.url);
        if (urlObj.protocol === undefined) {
            throw new Error("No protocol provided");
        }
        const factory: IDocumentServiceFactory | undefined = this.protocolToDocumentFactoryMap.get(urlObj.protocol);
        if (factory === undefined) {
            throw new Error("Unknown Fluid protocol");
        }
        return factory.createContainer(createNewSummary, createNewResolvedUrl, logger);
    }
}
