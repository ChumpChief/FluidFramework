/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IEvent, IErrorEvent } from "@fluidframework/common-definitions";
import {
    ConnectionMode,
    ISequencedDocumentMessage,
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
    initialMessages: ISequencedDocumentMessage[];
    initialSignals: ISignalMessage[];
    maxMessageSize: number;
}

/**
 * Interface used to define a strategy for handling incoming delta messages
 */
export interface IDeltaHandlerStrategy {
    /**
     * Processes the message.
     */
    process: (message: ISequencedDocumentMessage) => void;

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
    submit(type: MessageType, contents: any): number;
}

/** Events emitted by the Delta Manager */
export interface IDeltaManagerEvents extends IEvent {
    (event: "connect", listener: (details: IConnectionDetails, opsBehind?: number) => void);
    (event: "disconnect", listener: (reason: string) => void);
    (event: "readonly", listener: (readonly: boolean) => void);
}

/**
 * Manages the transmission of ops between the runtime and storage.
 */
export interface IDeltaManager<T, U> extends IEventProvider<IDeltaManagerEvents> {
    /** The current minimum sequence number */
    readonly minimumSequenceNumber: number;

    /** The last sequence number processed by the delta manager */
    readonly lastSequenceNumber: number;

    /** The initial sequence number set when attaching the op handler */
    readonly initialSequenceNumber: number;

    /**
     * Submits the given delta returning the client sequence number for the message. Contents is the actual
     * contents of the message. appData is optional metadata that can be attached to the op by the app.
     *
     * If batch is set to true then the submit will be batched - and as a result guaranteed to be ordered sequentially
     * in the global sequencing space. The batch will be flushed either when flush is called or when a non-batched
     * op is submitted.
     */
    submit(type: MessageType, contents: any): number;

    /** Submit a signal to the service to be broadcast to other connected clients, but not persisted */
    submitSignal(content: any): void;
}

/** Events emmitted by a Delta Queue */
export interface IDeltaQueueEvents<T> extends IErrorEvent {
    (event: "push" | "op", listener: (task: T) => void);
}

/**
 * Queue of ops to be sent to or processed from storage
 */
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
