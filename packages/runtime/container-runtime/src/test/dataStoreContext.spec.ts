/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import { BlobCacheStorageService } from "@fluidframework/driver-utils";
import { IBlob, ISnapshotTree } from "@fluidframework/protocol-definitions";
import {
    IFluidDataStoreChannel,
    IFluidDataStoreContext,
    IFluidDataStoreFactory,
    IFluidDataStoreRegistry,
} from "@fluidframework/runtime-definitions";
import { MockFluidDataStoreRuntime } from "@fluidframework/test-runtime-utils";
import { IsoBuffer } from "@fluidframework/common-utils";
import {
    IFluidDataStoreAttributes,
    LocalFluidDataStoreContext,
    RemotedFluidDataStoreContext,
} from "../dataStoreContext";
import { ContainerRuntime } from "../containerRuntime";

describe("Data Store Context Tests", () => {
    const dataStoreId = "Test1";

    describe("LocalFluidDataStoreContext Initialization", () => {
        let localDataStoreContext: LocalFluidDataStoreContext;
        let storage: IDocumentStorageService;
        const attachCb = (mR: IFluidDataStoreChannel) => { };
        let containerRuntime: ContainerRuntime;
        beforeEach(async () => {
            const factory: IFluidDataStoreFactory = {
                type: "store-type",
                get IFluidDataStoreFactory() { return factory; },
                instantiateDataStore: async (context: IFluidDataStoreContext) => new MockFluidDataStoreRuntime(),
            };
            const registry: IFluidDataStoreRegistry = {
                get IFluidDataStoreRegistry() { return registry; },
                get: async (pkg) => Promise.resolve(factory),
            };
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            containerRuntime = {
                IFluidDataStoreRegistry: registry,
                notifyDataStoreInstantiated: (c) => { },
                on: (event, listener) => { },
            } as ContainerRuntime;
        });

        it("Check LocalDataStore Attributes", async () => {
            localDataStoreContext = new LocalFluidDataStoreContext(
                dataStoreId,
                ["TestDataStore1"],
                containerRuntime,
                storage,
                attachCb,
                undefined);

            await localDataStoreContext.realize();
            const attachMessage = localDataStoreContext.generateAttachMessage();

            const blob = attachMessage.snapshot.entries[0].value as IBlob;

            const contents = JSON.parse(blob.contents) as IFluidDataStoreAttributes;
            const dataStoreAttributes: IFluidDataStoreAttributes = {
                pkg: JSON.stringify(["TestDataStore1"]),
                snapshotFormatVersion: "0.1",
            };

            assert.equal(contents.pkg, dataStoreAttributes.pkg, "Local DataStore package does not match.");
            assert.equal(
                contents.snapshotFormatVersion,
                dataStoreAttributes.snapshotFormatVersion,
                "Local DataStore snapshot version does not match.");
            assert.equal(attachMessage.type, "TestDataStore1", "Attach message type does not match.");
        });

        it("Supplying array of packages in LocalFluidDataStoreContext should create exception", async () => {
            let exception = false;
            localDataStoreContext = new LocalFluidDataStoreContext(
                dataStoreId,
                ["TestComp", "SubComp"],
                containerRuntime,
                storage,
                attachCb,
                undefined);

            await localDataStoreContext.realize()
                .catch((error) => {
                    exception = true;
                });
            assert.equal(exception, true, "Exception did not occur.");
        });

        it("Supplying array of packages in LocalFluidDataStoreContext should not create exception", async () => {
            const registryWithSubRegistries: { [key: string]: any } = {};
            registryWithSubRegistries.IFluidDataStoreFactory = registryWithSubRegistries;
            registryWithSubRegistries.IFluidDataStoreRegistry = registryWithSubRegistries;
            registryWithSubRegistries.get = async (pkg) => Promise.resolve(registryWithSubRegistries);
            registryWithSubRegistries.instantiateDataStore =
                async (context: IFluidDataStoreContext) => new MockFluidDataStoreRuntime();

            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            containerRuntime = {
                IFluidDataStoreRegistry: registryWithSubRegistries,
                notifyDataStoreInstantiated: (c) => { },
                on: (event, listener) => { },
            } as ContainerRuntime;
            localDataStoreContext = new LocalFluidDataStoreContext(
                dataStoreId,
                ["TestComp", "SubComp"],
                containerRuntime,
                storage,
                attachCb,
                undefined);

            await localDataStoreContext.realize();

            const attachMessage = localDataStoreContext.generateAttachMessage();
            const blob = attachMessage.snapshot.entries[0].value as IBlob;
            const contents = JSON.parse(blob.contents) as IFluidDataStoreAttributes;
            const dataStoreAttributes: IFluidDataStoreAttributes = {
                pkg: JSON.stringify(["TestComp", "SubComp"]),
                snapshotFormatVersion: "0.1",
            };

            assert.equal(contents.pkg, dataStoreAttributes.pkg, "Local DataStore package does not match.");
            assert.equal(
                contents.snapshotFormatVersion,
                dataStoreAttributes.snapshotFormatVersion,
                "Local DataStore snapshot version does not match.");
            assert.equal(attachMessage.type, "SubComp", "Attach message type does not match.");
        });
    });

    describe("RemoteDataStoreContext Initialization", () => {
        let remotedDataStoreContext: RemotedFluidDataStoreContext;
        let dataStoreAttributes: IFluidDataStoreAttributes;
        const storage: Partial<IDocumentStorageService> = {};
        let containerRuntime: ContainerRuntime;
        beforeEach(async () => {
            const factory: { [key: string]: any } = {};
            factory.IFluidDataStoreFactory = factory;
            factory.instantiateDataStore =
                (context: IFluidDataStoreContext) => new MockFluidDataStoreRuntime();
            const registry: { [key: string]: any } = {};
            registry.IFluidDataStoreRegistry = registry;
            registry.get = async (pkg) => Promise.resolve(factory);

            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            containerRuntime = {
                IFluidDataStoreRegistry: registry,
                notifyDataStoreInstantiated: (c) => { },
                on: (event, listener) => { },
            } as ContainerRuntime;
        });

        it("Check RemotedDataStore Attributes", async () => {
            dataStoreAttributes = {
                pkg: JSON.stringify(["TestDataStore1"]),
                snapshotFormatVersion: "0.1",
            };
            const buffer = IsoBuffer.from(JSON.stringify(dataStoreAttributes), "utf-8");
            const blobCache = new Map<string, string>([["fluidDataStoreAttributes", buffer.toString("base64")]]);
            const snapshotTree: ISnapshotTree = {
                id: "dummy",
                blobs: { [".component"]: "fluidDataStoreAttributes" },
                commits: {},
                trees: {},
            };

            remotedDataStoreContext = new RemotedFluidDataStoreContext(
                dataStoreId,
                Promise.resolve(snapshotTree),
                containerRuntime,
                new BlobCacheStorageService(storage as IDocumentStorageService, Promise.resolve(blobCache)),
            );
            const snapshot = await remotedDataStoreContext.snapshot(true);
            const blob = snapshot.entries[0].value as IBlob;

            const contents = JSON.parse(blob.contents) as IFluidDataStoreAttributes;
            assert.equal(contents.pkg, dataStoreAttributes.pkg, "Remote DataStore package does not match.");
            assert.equal(
                contents.snapshotFormatVersion,
                dataStoreAttributes.snapshotFormatVersion,
                "Remote DataStore snapshot version does not match.");
        });

        it("Check RemotedDataStore Attributes without version", async () => {
            dataStoreAttributes = {
                pkg: "TestDataStore1",
            };
            const buffer = IsoBuffer.from(JSON.stringify(dataStoreAttributes), "utf-8");
            const blobCache = new Map<string, string>([["fluidDataStoreAttributes", buffer.toString("base64")]]);
            const snapshotTree: ISnapshotTree = {
                id: "dummy",
                blobs: { [".component"]: "fluidDataStoreAttributes" },
                commits: {},
                trees: {},
            };

            remotedDataStoreContext = new RemotedFluidDataStoreContext(
                dataStoreId,
                Promise.resolve(snapshotTree),
                containerRuntime,
                new BlobCacheStorageService(storage as IDocumentStorageService, Promise.resolve(blobCache)),
            );
            const snapshot = await remotedDataStoreContext.snapshot(true);
            const blob = snapshot.entries[0].value as IBlob;

            const contents = JSON.parse(blob.contents) as IFluidDataStoreAttributes;
            assert.equal(
                contents.pkg,
                JSON.stringify([dataStoreAttributes.pkg]),
                "Remote DataStore package does not match.");
            assert.equal(contents.snapshotFormatVersion, "0.1", "Remote DataStore snapshot version does not match.");
        });
    });
});
