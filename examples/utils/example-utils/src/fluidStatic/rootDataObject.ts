/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import {
    DataObject,
    DataObjectFactory,
    defaultRouteRequestHandler,
} from "@fluidframework/aqueduct";
import { IContainer, IContainerContext, IRuntime, IRuntimeFactory } from "@fluidframework/container-definitions";
import { ContainerRuntime } from "@fluidframework/container-runtime";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import { IFluidLoadable } from "@fluidframework/core-interfaces";
import { buildRuntimeRequestHandler } from "@fluidframework/request-handler";
import { FlushMode } from "@fluidframework/runtime-definitions";
import { requestFluidObject } from "@fluidframework/runtime-utils";
import { makeModelRequestHandler } from "../modelLoader";
import { FluidContainer } from "./fluidContainer";
import {
    ContainerSchema,
    DataObjectClass,
    LoadableObjectClass,
    LoadableObjectClassRecord,
    LoadableObjectRecord,
    SharedObjectClass,
} from "./types";
import { isDataObjectClass, isSharedObjectClass, parseDataObjectsFromSharedObjects } from "./utils";

/**
 * Input props for {@link RootDataObject.initializingFirstTime}.
 */
export interface RootDataObjectProps {
    /**
     * Initial object structure with which the {@link RootDataObject} will be first-time initialized.
     *
     * @see {@link RootDataObject.initializingFirstTime}
     */
    initialObjects: LoadableObjectClassRecord;
}

/**
 * The entry-point/root collaborative object of the {@link IFluidContainer | Fluid Container}.
 * Abstracts the dynamic code required to build a Fluid Container into a static representation for end customers.
 */
export class RootDataObject extends DataObject<{ InitialState: RootDataObjectProps; }> {
    private readonly initialObjectsDirKey = "initial-objects-key";
    private readonly _initialObjects: LoadableObjectRecord = {};

    private get initialObjectsDir() {
        const dir = this.root.getSubDirectory(this.initialObjectsDirKey);
        if (dir === undefined) {
            throw new Error("InitialObjects sub-directory was not initialized");
        }
        return dir;
    }

    /**
     * The first time this object is initialized, creates each object identified in
     * {@link RootDataObjectProps.initialObjects} and stores them as unique values in the root directory.
     *
     * @see {@link @fluidframework/aqueduct#PureDataObject.initializingFirstTime}
     */
    protected async initializingFirstTime(props: RootDataObjectProps) {
        this.root.createSubDirectory(this.initialObjectsDirKey);

        // Create initial objects provided by the developer
        const initialObjectsP: Promise<void>[] = [];
        Object.entries(props.initialObjects).forEach(([id, objectClass]) => {
            const createObject = async () => {
                const obj = await this.create(objectClass);
                this.initialObjectsDir.set(id, obj.handle);
            };
            initialObjectsP.push(createObject());
        });

        await Promise.all(initialObjectsP);
    }

    /**
     * Every time an instance is initialized, loads all of the initial objects in the root directory so they can be
     * accessed immediately.
     *
     * @see {@link @fluidframework/aqueduct#PureDataObject.hasInitialized}
     */
    protected async hasInitialized() {
        // We will always load the initial objects so they are available to the developer
        const loadInitialObjectsP: Promise<void>[] = [];
        for (const [key, value] of Array.from(this.initialObjectsDir.entries())) {
            const loadDir = async () => {
                const obj = await value.get();
                Object.assign(this._initialObjects, { [key]: obj });
            };
            loadInitialObjectsP.push(loadDir());
        }

        await Promise.all(loadInitialObjectsP);
    }

    /**
     * Provides a record of the initial objects defined on creation.
     *
     * @see {@link RootDataObject.initializingFirstTime}
     */
    public get initialObjects(): LoadableObjectRecord {
        if (Object.keys(this._initialObjects).length === 0) {
            throw new Error("Initial Objects were not correctly initialized");
        }
        return this._initialObjects;
    }

    /**
     * Dynamically creates a new detached collaborative object (DDS/DataObject).
     *
     * @param objectClass - Type of the collaborative object to be created.
     *
     * @typeParam T - The class of the `DataObject` or `SharedObject`.
     */
    public async create<T extends IFluidLoadable>(
        objectClass: LoadableObjectClass<T>,
    ): Promise<T> {
        if (isDataObjectClass(objectClass)) {
            return this.createDataObject<T>(objectClass);
        } else if (isSharedObjectClass(objectClass)) {
            return this.createSharedObject<T>(objectClass);
        }
        throw new Error("Could not create new Fluid object because an unknown object was passed");
    }

    private async createDataObject<T extends IFluidLoadable>(dataObjectClass: DataObjectClass<T>): Promise<T> {
        const factory = dataObjectClass.factory;
        const packagePath = [...this.context.packagePath, factory.type];
        const router = await this.context.containerRuntime.createDataStore(packagePath);
        return requestFluidObject<T>(router, "/");
    }

    private createSharedObject<T extends IFluidLoadable>(
        sharedObjectClass: SharedObjectClass<T>,
    ): T {
        const factory = sharedObjectClass.getFactory();
        const obj = this.runtime.createChannel(undefined, factory.type);
        return obj as unknown as T;
    }
}

const rootDataStoreId = "rootDOId";

export interface IDOProviderModelType<ContainerServicesType> {
    container: FluidContainer;
    services: ContainerServicesType;
}

export class DOProviderContainerRuntimeFactory<ContainerServicesType> implements IRuntimeFactory {
    public get IRuntimeFactory() { return this; }

    private readonly rootDataObjectFactory: DataObjectFactory<RootDataObject, {
        InitialState: RootDataObjectProps;
    }>;

    private readonly initialObjects: LoadableObjectClassRecord;

    private readonly _servicesCallback: ((container: IContainer) => ContainerServicesType) | undefined;
    private get servicesCallback(): (container: IContainer) => ContainerServicesType {
        if (this._servicesCallback === undefined) {
            throw new Error("servicesCallback not provided");
        }
        return this._servicesCallback;
    }

    /**
     * @param registryEntries - The data store registry for containers produced
     * @param runtimeOptions - The runtime options passed to the ContainerRuntime when instantiating it
     */
    public constructor(
        schema: ContainerSchema,
        servicesCallback?: (container: IContainer) => ContainerServicesType,
    ) {
        const [registryEntries, sharedObjects] = parseDataObjectsFromSharedObjects(schema);
        this.rootDataObjectFactory = new DataObjectFactory(
            "rootDO",
            RootDataObject,
            sharedObjects,
            {},
            registryEntries,
        );
        this.initialObjects = schema.initialObjects;
        this._servicesCallback = servicesCallback;
    }

    public async instantiateRuntime(
        context: IContainerContext,
        existing?: boolean,
    ): Promise<IRuntime> {
        const fromExisting = existing ?? context.existing ?? false;
        const runtime = await ContainerRuntime.load(
            context,
            [this.rootDataObjectFactory.registryEntry],
            buildRuntimeRequestHandler(
                makeModelRequestHandler(this.createModel.bind(this)),
                // For compatibility with the previous version of the client which isn't expecting model loading.
                // Since the old clients don't include the containerRef header, the request will fall through.
                defaultRouteRequestHandler(rootDataStoreId),
            ),
            // temporary workaround to disable message batching until the message batch size issue is resolved
            // resolution progress is tracked by the Feature 465 work item in AzDO
            { flushMode: FlushMode.Immediate },
            undefined, // scope
            existing,
        );

        if (!fromExisting) {
            await this.containerInitializingFirstTime(runtime);
        }
        await this.containerHasInitialized(runtime);

        return runtime;
    }

    /**
     * Subclasses may override containerInitializingFirstTime to perform any setup steps at the time the container
     * is created. This likely includes creating any initial data stores that are expected to be there at the outset.
     * @param runtime - The container runtime for the container being initialized
     */
    private async containerInitializingFirstTime(runtime: IContainerRuntime): Promise<void> {
        // The first time we create the container we create the RootDataObject
        await this.rootDataObjectFactory.createRootInstance(
            rootDataStoreId,
            runtime,
            { initialObjects: this.initialObjects },
        );
    }

    /**
     * Subclasses may override containerHasInitialized to perform any steps after the container has initialized.
     * This likely includes loading any data stores that are expected to be there at the outset.
     * @param runtime - The container runtime for the container being initialized
     */
    private async containerHasInitialized(runtime: IContainerRuntime): Promise<void> { }

    /**
     * Subclasses must implement createModel, which should build a ModelType given the runtime and container.
     * @param runtime - The container runtime for the container being initialized
     * @param container - The container being initialized
     */
    private async createModel(
        runtime: IContainerRuntime,
        container: IContainer,
    ): Promise<IDOProviderModelType<ContainerServicesType>> {
        if (this.servicesCallback === undefined) {
            throw new Error("Need a services callback to be used with model loading.");
        }
        const rootDataObject = await requestFluidObject<RootDataObject>(
            await runtime.getRootDataStore(rootDataStoreId),
            "",
        );
        return {
            container: new FluidContainer(container, rootDataObject),
            services: this.servicesCallback(container),
        };
    }
}
