/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

 import assert from "assert";
import { IRequest } from "@fluidframework/core-interfaces";
import { FluidDataStoreRuntime, ISharedObjectRegistry } from "@fluidframework/datastore";
import { FluidDataStoreRegistry } from "@fluidframework/container-runtime";
import {
    IFluidDataStoreContext,
    IContainerRuntimeBase,
    IFluidDataStoreFactory,
    IFluidDataStoreRegistry,
    IProvideFluidDataStoreRegistry,
    NamedFluidDataStoreRegistryEntries,
    NamedFluidDataStoreRegistryEntry,
} from "@fluidframework/runtime-definitions";
import { IChannelFactory } from "@fluidframework/datastore-definitions";

import {
    IDataObjectProps,
    PureDataObject,
} from "../data-objects";

function buildRegistryPath(
    context: IFluidDataStoreContext,
    factory: IFluidDataStoreFactory)
{
    const parentPath = context.packagePath;
    assert(parentPath.length > 0);
    // A factory could not contain the registry for itself. So if it is the same the last snapshot
    // pkg, return our package path.
    assert(parentPath[parentPath.length - 1] !== factory.type);
    return [...parentPath, factory.type];
}

/**
 * PureDataObjectFactory is a barebones IFluidDataStoreFactory for use with PureDataObject.
 * Consumers should typically use DataObjectFactory instead unless creating
 * another base data store factory.
 *
 * Generics:
 * P - represents a type that will define optional providers that will be injected
 * S - the initial state type that the produced data store may take during creation
 */
export class PureDataObjectFactory<TObj extends PureDataObject<P, S>, P, S>
    implements IFluidDataStoreFactory, Partial<IProvideFluidDataStoreRegistry>
{
    private readonly sharedObjectRegistry: ISharedObjectRegistry;
    private readonly registry: IFluidDataStoreRegistry | undefined;

    constructor(
        public readonly type: string,
        private readonly ctor: new (props: IDataObjectProps<P>) => TObj,
        sharedObjects: readonly IChannelFactory[],
        registryEntries?: NamedFluidDataStoreRegistryEntries,
        private readonly onDemandInstantiation = true,
    ) {
        if (this.type === "") {
            throw new Error("undefined type member");
        }
        if (registryEntries !== undefined) {
            this.registry = new FluidDataStoreRegistry(registryEntries);
        }
        this.sharedObjectRegistry = new Map(sharedObjects.map((ext) => [ext.type, ext]));
    }

    public get IFluidDataStoreFactory() { return this; }

    public get IFluidDataStoreRegistry() {
        return this.registry;
    }

    /**
     * Convenience helper to get the data store's/factory's data store registry entry.
     * The return type hides the factory's generics, easing grouping of registry
     * entries that differ only in this way into the same array.
     * @returns The NamedFluidDataStoreRegistryEntry
     */
    public get registryEntry(): NamedFluidDataStoreRegistryEntry {
        return [this.type, Promise.resolve(this)];
    }

    /**
     * This is where we do data store setup.
     *
     * @param context - data store context used to load a data store runtime
     */
    public async instantiateDataStore(context: IFluidDataStoreContext) {
        return this.instantiateDataStoreCore(context);
    }

    /**
     * Private method for data store instantiation that exposes initial state
     *
     * @param context - data store context used to load a data store runtime
     */
    protected instantiateDataStoreCore(context: IFluidDataStoreContext, props?: S) {
        // Create a new runtime for our data store
        // The runtime is what Fluid uses to create DDS' and route to your data store
        const runtime = FluidDataStoreRuntime.load(
            context,
            this.sharedObjectRegistry,
        );

        let instanceP: Promise<TObj>;
        // For new runtime, we need to force the data store instance to be create
        // run the initialization.
        if (!this.onDemandInstantiation || !runtime.existing) {
            // Create a new instance of our component up front
            instanceP = this.instantiateInstance(runtime, context, props);
        }

        runtime.registerRequestHandler(async (request: IRequest) => {
            // eslint-disable-next-line @typescript-eslint/no-misused-promises
            if (!instanceP) {
                // Create a new instance of our data store on demand
                instanceP = this.instantiateInstance(runtime, context, props);
            }
            const instance = await instanceP;
            return instance.request(request);
        });

        return runtime;
    }

    /**
     * Instantiate and initialize the data store object
     * @param runtime - data store runtime created for the data store context
     * @param context - data store context used to load a data store runtime
     */
    private async instantiateInstance(
        runtime: FluidDataStoreRuntime,
        context: IFluidDataStoreContext,
        props?: S,
    ): Promise<TObj> {
        // Create a new instance of our data store
        const instance = new this.ctor({ runtime, context });
        await instance.initializeInternal(props);
        return instance;
    }

   /**
    * Takes context, and creates package path for a sub-entry (represented by factory in context registry).
    * Package path returned is used to reach given factory from root (container runtime) registry, and thus
    * is used to serialize and de-serialize data store that this factory would create.
    * Function validates that given factory is present in registry, otherwise it throws.
    */
   protected buildRegistryPath(
       context: IFluidDataStoreContext | IContainerRuntimeBase)
   {
       let packagePath: string[];
       if ("containerRuntime" in context) {
           packagePath = buildRegistryPath(context, this);
       } else {
           packagePath = [this.type];
       }

       return packagePath;
   }
}
