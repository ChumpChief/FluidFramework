/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { IRequest } from "@fluidframework/core-interfaces";
import {
    ContainerErrorType,
} from "@fluidframework/container-definitions";
import { Container } from "@fluidframework/container-loader";
import {
    IFluidResolvedUrl,
    IDocumentServiceFactory,
    DriverErrorType,
} from "@fluidframework/driver-definitions";
import { createWriteError } from "@fluidframework/driver-utils";
import { CustomErrorWithProps } from "@fluidframework/telemetry-utils";
import { CreateContainerError } from "@fluidframework/container-utils";
import { LocalDocumentServiceFactory, LocalResolver } from "@fluidframework/local-driver";
import { ILocalDeltaConnectionServer, LocalDeltaConnectionServer } from "@fluidframework/server-local-server";
import { LocalCodeLoader } from "@fluidframework/test-utils";

describe("Errors Types", () => {
    const id = "fluid-test://localhost/errorTest";
    const testRequest: IRequest = { url: id };

    let testDeltaConnectionServer: ILocalDeltaConnectionServer;
    let localResolver: LocalResolver;
    let testResolved: IFluidResolvedUrl;
    let serviceFactory: IDocumentServiceFactory;
    let codeLoader: LocalCodeLoader;

    it("GeneralError Test", async () => {
        // Setup
        testDeltaConnectionServer = LocalDeltaConnectionServer.create();
        localResolver = new LocalResolver();
        testResolved = await localResolver.resolve(testRequest) as IFluidResolvedUrl;
        serviceFactory = new LocalDocumentServiceFactory(testDeltaConnectionServer);

        codeLoader = new LocalCodeLoader([]);

        try {
            const mockFactory = Object.create(serviceFactory) as IDocumentServiceFactory;
            // Issue typescript-eslint/typescript-eslint #1256
            // eslint-disable-next-line @typescript-eslint/unbound-method
            mockFactory.createDocumentService = async (resolvedUrl) => {
                const service = await serviceFactory.createDocumentService(resolvedUrl);
                // Issue typescript-eslint/typescript-eslint #1256
                // eslint-disable-next-line @typescript-eslint/unbound-method
                service.connectToDeltaStorage = async () => Promise.reject(false);
                return service;
            };

            await Container.load(
                "documentId",
                mockFactory,
                codeLoader,
                testRequest,
                testResolved,
                localResolver);

            assert.fail("Error expected");
        } catch (error) {
            assert.equal(error.errorType, ContainerErrorType.genericError, "Error should be a genericError");
        }

        await testDeltaConnectionServer.webSocketServer.close();
    });

    it("GeneralError Logging Test", async () => {
        const err = {
            userData: "My name is Mark",
            message: "Some message",
        };
        const iError = (CreateContainerError(err) as any) as CustomErrorWithProps;
        const props = iError.getCustomProperties();
        assert.equal(props.userData, undefined, "We shouldn't expose the properties of the inner/original error");
        assert.equal(props.message, err.message, "But name is copied over!");
    });

    function assertCustomPropertySupport(err: any) {
        err.asdf = "asdf";
        if (err.getCustomProperties !== undefined) {
            assert.equal(err.getCustomProperties().asdf, "asdf", "Error should have property asdf");
        }
        else {
            assert.fail("Error should support getCustomProperties()");
        }
    }

    it("WriteError Test", async () => {
        const writeError = createWriteError("Test Error");
        assertCustomPropertySupport(writeError);
        assert.equal(writeError.errorType, DriverErrorType.writeError, "Error should be a writeError");
        assert.equal(writeError.canRetry, false, "Error should be critical");
    });

    it("string test", async () => {
        const text = "Sample text";
        const writeError = CreateContainerError(text);
        assertCustomPropertySupport(writeError);
        assert.equal(writeError.errorType, DriverErrorType.genericError, "Error should be a writeError");
        assert.equal(writeError.message, text, "Text is preserved");
    });

    it("Check double conversion of general error", async () => {
        const err = {
            message: "Test Error",
        };
        const error1 = CreateContainerError(err);
        const error2 = CreateContainerError(error1);
        assertCustomPropertySupport(error1);
        assertCustomPropertySupport(error2);
        assert.deepEqual(error1, error2, "Both errors should be same!!");
        assert.deepEqual(error2.message, err.message, "Message text should not be lost!!");
    });

    it("Check frozen error", async () => {
        const err = {
            message: "Test Error",
        };
        CreateContainerError(Object.freeze(err));
    });

    it("Preserve existing properties", async () => {
        const err1 = {
            errorType: "Something",
            message: "Test Error",
            canRetry: true,
        };
        const error1 = CreateContainerError(err1);
        const error2 = CreateContainerError(Object.freeze(error1));
        assert.equal(error1.errorType, err1.errorType, "Preserve errorType 1");
        assert.equal(error2.errorType, err1.errorType, "Preserve errorType 2");
    });
});
