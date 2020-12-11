/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDisposable, IEventProvider, IEvent, IErrorEvent } from "@fluidframework/common-definitions";
import {
    ConnectionMode,
    IDocumentMessage,
    IProcessMessageResult,
    ISequencedDocumentMessage,
    IServiceConfiguration,
    ISignalClient,
    ISignalMessage,
    ITokenClaims,
    MessageType,
} from "@fluidframework/protocol-definitions";

/**
 * Contract representing the result of a newly established connection to the server for syncing deltas
 */
export interface IConnectionDetails {
    clientId: string;
    claims: ITokenClaims;
    existing: boolean;
    mode: ConnectionMode;
    version: string;
    initialClients: ISignalClient[];
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

/**
 * Contract supporting delivery of outbound messages to the server
 */
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

    /**
     * Flush all pending messages through the outbound queue
     */
    flush(): void;
}

/** Events emitted by the Delta Manager */
export interface IDeltaManagerEvents extends IEvent {
    (event: "prepareSend", listener: (messageBuffer: any[]) => void);
    (event: "processSignal", listener: (message: ISignalMessage) => void);
    (event: "submitOp", listener: (message: IDocumentMessage) => void);
    (event: "beforeOpProcessing" | "processOp", listener: (message: ISequencedDocumentMessage) => void);
    (event: "allSentOpsAckd", listener: () => void);
    (event: "processTime", listener: (latency: number) => void);
    (event: "connect", listener: (details: IConnectionDetails) => void);
    (event: "disconnect", listener: (reason: string) => void);
    (event: "readonly", listener: (readonly: boolean) => void);
}

/**
 * Manages the transmission of ops between the runtime and storage.
 */
export interface IDeltaManager<T, U> extends IEventProvider<IDeltaManagerEvents>, IDeltaSender {
    /** The queue of inbound delta messages */
    readonly inbound: IDeltaQueue<T>;

    /** The queue of outbound delta messages */
    readonly outbound: IDeltaQueue<U[]>;

    /** The queue of inbound delta signals */
    readonly inboundSignal: IDeltaQueue<ISignalMessage>;

    /** The current minimum sequence number */
    readonly minimumSequenceNumber: number;

    /** The last sequence number processed by the delta manager */
    readonly lastSequenceNumber: number;

    /** Protocol version being used to communicate with the service */
    readonly version: string;

    /** Max message size allowed to the delta manager */
    readonly maxMessageSize: number;

    /** Service configuration provided by the service. */
    readonly serviceConfiguration: IServiceConfiguration | undefined;

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

    /** Terminate the connection to storage */
    close(): void;

    /** Submit a signal to the service to be broadcast to other connected clients, but not persisted */
    submitSignal(content: any): void;
}

/** Events emitted by a Delta Queue */
export interface IDeltaQueueEvents<T> extends IErrorEvent {
    (event: "push", listener: (task: T) => void);
    (event: "idle", listener: () => void);
}

/**
 * Queue of ops to be sent to or processed from storage
 */
export interface IDeltaQueue<T> extends IEventProvider<IDeltaQueueEvents<T>>, IDisposable {
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
