/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { IErrorBase } from "@fluidframework/container-definitions";
import { CustomErrorWithProps } from "@fluidframework/telemetry-utils";
import { ITelemetryProperties } from "@fluidframework/common-definitions";
import {
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";
import Deque from "double-ended-queue";
import { ContainerRuntime, ContainerMessageType } from "./containerRuntime";

export class DataCorruptionError extends CustomErrorWithProps implements IErrorBase {
    readonly errorType = "dataCorruptionError";
    readonly canRetry = false;

    constructor(
        errorMessage: string,
        props: ITelemetryProperties,
    ) {
        super(errorMessage, props);
    }
}

/**
 * This represents a message that has been submitted and is added to the pending queue when `submit` is called on the
 * ContainerRuntime. This message has either not been ack'd by the server or has not been submitted to the server yet.
 */
interface IPendingMessage {
    type: "message";
    messageType: ContainerMessageType;
    clientSequenceNumber: number;
    content: any;
    localOpMetadata: unknown;
}

type IPendingState = IPendingMessage;

/**
 * PendingStateManager is responsible for maintaining the messages that have not been sent or have not yet been
 * acknowledged by the server. It also maintains the batch information for both automatically and manually flushed
 * batches along with the messages.
 * When the Container reconnects, it replays the pending states, which includes setting the FlushMode, manual flushing
 * of messages and triggering resubmission of unacked ops.
 *
 * It verifies that all the ops are acked, are received in the right order and batch information is correct.
 */
export class PendingStateManager {
    private readonly pendingStates = new Deque<IPendingState>();

    // Maintains the count of messages that are currently unacked.
    private pendingMessagesCount: number = 0;

    private clientId: string | undefined;

    /**
     * Called to check if there are any pending messages in the pending state queue.
     * @returns A boolean indicating whether there are messages or not.
     */
    public hasPendingMessages(): boolean {
        return this.pendingMessagesCount !== 0;
    }

    constructor(private readonly containerRuntime: ContainerRuntime) { }

    /**
     * Called when a message is submitted locally. Adds the message and the associated details to the pending state
     * queue.
     * @param type - The container message type.
     * @param clientSequenceNumber - The clientSequenceNumber associated with the message.
     * @param content - The message content.
     * @param localOpMetadata - The local metadata associated with the message.
     */
    public onSubmitMessage(
        type: ContainerMessageType,
        clientSequenceNumber: number,
        content: any,
        localOpMetadata: unknown) {
        const pendingMessage: IPendingMessage = {
            type: "message",
            messageType: type,
            clientSequenceNumber,
            content,
            localOpMetadata,
        };

        this.pendingStates.push(pendingMessage);

        this.pendingMessagesCount++;
    }

    /**
     * Processes a local message once its ack'd by the server. It verifies that there was no data corruption and that
     * the batch information was preserved for batch messages.
     * @param message - The messsage that got ack'd and needs to be processed.
     */
    public processPendingLocalMessage(message: ISequencedDocumentMessage): unknown {
        // Get the next state from the pending queue and verify that it is of type "message".
        const pendingState = this.peekNextPendingState();
        assert(pendingState.type === "message", "No pending message found for this remote message");
        this.pendingStates.shift();

        // Processing part - Verify that there has been no data corruption.
        // The clientSequenceNumber of the incoming message must match that of the pending message.
        if (pendingState.clientSequenceNumber !== message.clientSequenceNumber) {
            throw new Error("Unexpected ack received in pendingStateManager");
        }

        this.pendingMessagesCount--;

        return pendingState.localOpMetadata;
    }

    /**
     * Returns the next pending state from the pending state queue.
     */
    private peekNextPendingState(): IPendingState {
        const nextPendingState = this.pendingStates.peekFront();
        assert(nextPendingState, "No pending state found for the remote message");
        return nextPendingState;
    }

    /**
     * Called when the Container's connection state changes. If the Container gets connected, it replays all the pending
     * states in its queue. This includes setting the FlushMode and trigerring resubmission of unacked ops.
     */
    public replayPendingStates() {
        // This assert suggests we are about to send same ops twice, which will result in data loss.
        assert(this.clientId !== this.containerRuntime.clientId, "replayPendingStates called twice for same clientId!");
        this.clientId = this.containerRuntime.clientId;

        let pendingStatesCount = this.pendingStates.length;
        if (pendingStatesCount === 0) {
            return;
        }

        // Reset the pending message count because all these messages will be removed from the queue.
        this.pendingMessagesCount = 0;

        // Process exactly `pendingStatesCount` items in the queue as it represents the number of states that were
        // pending when we connected. This is important because the `reSubmitFn` might add more items in the queue
        // which must not be replayed.
        while (pendingStatesCount > 0) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const pendingState = this.pendingStates.shift()!;
            switch (pendingState.type) {
                case "message":
                    {
                        this.containerRuntime.reSubmitFn(
                            pendingState.messageType,
                            pendingState.content,
                            pendingState.localOpMetadata);
                    }
                    break;
                default:
                    break;
            }
            pendingStatesCount--;
        }
    }
}
