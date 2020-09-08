/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IEvent, IErrorEvent } from "@fluidframework/common-definitions";
import {
    ConnectionMode,
    IClientDetails,
    IProcessMessageResult,
    ISequencedDocumentMessage,
    IServiceConfiguration,
    ISignalClient,
    ISignalMessage,
    ITokenClaims,
    MessageType,
} from "@fluidframework/protocol-definitions";

export interface IConnectionDetails {
    clientId: string;
    claims: ITokenClaims;
    existing: boolean;
    mode: ConnectionMode;
    version: string;
    initialClients: ISignalClient[];
    initialMessages: ISequencedDocumentMessage[];
    initialSignals: ISignalMessage[];
    maxMessageSize: number;
    serviceConfiguration: IServiceConfiguration;
}

/**
 * Interface used to define a strategy for handling incoming delta messages
 */
export interface IDeltaHandlerStrategy {
    /**
     * Processes the message.
     */
    process: (message: ISequencedDocumentMessage) => IProcessMessageResult;

    /**
     * Processes the signal.
     */
    processSignal: (message: ISignalMessage) => void;
}

declare module "@fluidframework/core-interfaces" {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface IFluidObject extends Readonly<Partial<IProvideDeltaSender>> { }
}

export const IDeltaSender: keyof IProvideDeltaSender = "IDeltaSender";

export interface IProvideDeltaSender {
    readonly IDeltaSender: IDeltaSender;
}

export interface IDeltaSender extends IProvideDeltaSender {
    /**
     * Submits the given delta returning the client sequence number for the message. Contents is the actual
     * contents of the message. appData is optional metadata that can be attached to the op by the app.
     *
     * If batch is set to true then the submit will be batched - and as a result guaranteed to be ordered sequentially
     * in the global sequencing space. The batch will be flushed either when flush is called or when a non-batched
     * op is submitted.
     */
    submit(type: MessageType, contents: any, batch: boolean, metadata: any): number;

    flush(): void;
}

export interface IDeltaManagerEvents extends IEvent {
    (event: "prepareSend", listener: (messageBuffer: any[]) => void);
    (event: "connect", listener: (details: IConnectionDetails, opsBehind?: number) => void);
    (event: "disconnect", listener: (reason: string) => void);
    (event: "readonly", listener: (readonly: boolean) => void);
}

export interface IDeltaManager<T, U> extends IEventProvider<IDeltaManagerEvents>, IDeltaSender {
    // The queue of inbound delta messages
    readonly inbound: IDeltaQueue<T>;

    // The queue of outbound delta messages
    readonly outbound: IDeltaQueue<U[]>;

    // The queue of inbound delta signals
    readonly inboundSignal: IDeltaQueue<ISignalMessage>;

    // The current minimum sequence number
    readonly minimumSequenceNumber: number;

    // The last sequence number processed by the delta manager
    readonly lastSequenceNumber: number;

    // The initial sequence number set when attaching the op handler
    readonly initialSequenceNumber: number;

    // Details of client
    readonly clientDetails: IClientDetails;

    // Max message size allowed to the delta manager
    readonly maxMessageSize: number;

    // Service configuration provided by the service.
    readonly serviceConfiguration: IServiceConfiguration | undefined;

    // Flag to indicate whether the client can write or not.
    readonly active: boolean;

    /**
     * Tells if container is in read-only mode.
     * Data stores should listen for "readonly" notifications and disallow user making changes to data stores.
     * Readonly state can be because of no storage write permission,
     * or due to host forcing readonly mode for container.
     *
     * We do not differentiate here between no write access to storage vs. host disallowing changes to container -
     * in all cases container runtime and data stores should respect readonly state and not allow local changes.
     *
     * It is undefined if we have not yet established websocket connection
     * and do not know if user has write access to a file.
     */
    readonly readonly?: boolean;

    submitSignal(content: any): void;
}

export interface IDeltaQueueEvents<T> extends IErrorEvent {
    (event: "push" | "op", listener: (task: T) => void);
    (event: "idle", listener: () => void);
}

export interface IDeltaQueue<T> extends IEventProvider<IDeltaQueueEvents<T>> {
    /**
     * Flag indicating whether or not the queue was paused
     */
    paused: boolean;

    /**
     * The number of messages remaining in the queue
     */
    length: number;

    /**
     * Flag indicating whether or not the queue is idle
     */
    idle: boolean;

    /**
     * Pauses processing on the queue
     * @returns A promise which resolves when processing has been paused.
     */
    pause(): Promise<void>;

    /**
     * Resumes processing on the queue
     */
    resume(): void;

    /**
     * Peeks at the next message in the queue
     */
    peek(): T | undefined;

    /**
     * Returns all the items in the queue as an array. Does not remove them from the queue.
     */
    toArray(): T[];

    /**
     * System level pause
     * @returns A promise which resolves when processing has been paused.
     */
    systemPause(): Promise<void>;

    /**
     * System level resume
     */
    systemResume(): void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaFeedFollowerEvents extends IErrorEvent {
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaFeedFollower extends IEventProvider<IDeltaFeedFollowerEvents> {
}
