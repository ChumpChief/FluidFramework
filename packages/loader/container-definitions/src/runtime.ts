/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDisposable } from "@fluidframework/common-definitions";
import {
    IFluidConfiguration,
    IRequest,
    IResponse,
} from "@fluidframework/core-interfaces";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import {
    IClientDetails,
    IQuorum,
    ISequencedDocumentMessage,
    IServiceConfiguration,
    ISnapshotTree,
    ITree,
    MessageType,
    ISummaryTree,
    IVersion,
} from "@fluidframework/protocol-definitions";
import { IAudience } from "./audience";
import { IBlobManager } from "./blobs";
import { ILoader } from "./loader";
import { IMessageScheduler } from "./messageScheduler";

// Represents the attachment state of the entity.
export enum AttachState {
    Detached = "Detached",
    Attaching = "Attaching",
    Attached = "Attached",
}

// Represents the bind state of the entity.
export enum BindState {
    NotBound = "NotBound",
    Binding = "Binding",
    Bound = "Bound",
}

/**
 * The IRuntime represents an instantiation of a code package within a container.
 */
export interface IRuntime extends IDisposable {

    /**
     * Executes a request against the runtime
     */
    request(request: IRequest): Promise<IResponse>;

    /**
     * Snapshots the runtime
     */
    snapshot(tagMessage: string, fullTree?: boolean): Promise<ITree | null>;

    /**
     * Notifies the runtime of a change in the connection state
     */
    setConnectionState(connected: boolean, clientId?: string);

    /**
     * Processes the given message
     */
    process(message: ISequencedDocumentMessage, local: boolean, context: any);

    /**
     * Processes the given signal
     */
    processSignal(message: any, local: boolean);

    createSummary(): ISummaryTree;

    /**
     * Propagate the container state when container is attaching or attached.
     * @param attachState - State of the container.
     */
    setAttachState(attachState: AttachState.Attaching | AttachState.Attached): void;
}

export interface IContainerContext extends IMessageScheduler, IDisposable {
    readonly existing: boolean | undefined;
    readonly configuration: IFluidConfiguration;
    readonly clientId: string | undefined;
    readonly clientDetails: IClientDetails;
    readonly blobManager: IBlobManager | undefined;
    readonly storage: IDocumentStorageService | undefined | null;
    readonly connected: boolean;
    readonly baseSnapshot: ISnapshotTree | null;
    readonly submitFn: (type: MessageType, contents: any, batch: boolean, appData?: any) => number;
    readonly submitSignalFn: (contents: any) => void;
    readonly snapshotFn: (message: string) => Promise<void>;
    readonly quorum: IQuorum;
    readonly audience: IAudience | undefined;
    readonly loader: ILoader;
    readonly serviceConfiguration: IServiceConfiguration | undefined;

    requestSnapshot(tagMessage: string): Promise<void>;

    /**
     * Indicates the attachment state of the container to a host service.
     */
    readonly attachState: AttachState;

    getLoadedFromVersion(): IVersion | undefined;

    createSummary(): ISummaryTree;
}

export const IRuntimeFactory: keyof IProvideRuntimeFactory = "IRuntimeFactory";

export interface IProvideRuntimeFactory {
    readonly IRuntimeFactory: IRuntimeFactory;
}
/**
 * Exported module definition
 */
export interface IRuntimeFactory extends IProvideRuntimeFactory {
    /**
     * Instantiates a new chaincode container
     */
    instantiateRuntime(context: IContainerContext): Promise<IRuntime>;
}
