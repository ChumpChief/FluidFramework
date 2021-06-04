/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IHelpMessage,
    ISequencedDocumentSystemMessage,
    MessageType,
} from "@fluidframework/protocol-definitions";
import * as core from "@fluidframework/server-services-core";

export class ForemanLambda implements core.IPartitionLambda {
    private readonly taskQueueMap = new Map<string, string>();

    constructor(
        private readonly permissions: any,
        protected context: core.IContext,
        protected tenantId: string,
        protected documentId: string) {
        // Make a map of every task and their intended queue.
        // eslint-disable-next-line guard-for-in, no-restricted-syntax
        for (const queueName in this.permissions) {
            for (const task of this.permissions[queueName]) {
                this.taskQueueMap.set(task, queueName);
            }
        }
    }

    public close() {
    }

    public async handler(message: core.IQueuedMessage) {
        const boxcar = core.extractBoxcar(message);

        for (const baseMessage of boxcar.contents) {
            if (baseMessage.type === core.SequencedOperationType) {
                const sequencedMessage = baseMessage as core.ISequencedOperationMessage;
                // Only process "Help" messages.
                if (sequencedMessage.operation.type === MessageType.RemoteHelp) {
                    let helpContent: string[];
                    // eslint-disable-next-line max-len
                    const helpMessage: IHelpMessage = JSON.parse((sequencedMessage.operation as ISequencedDocumentSystemMessage).data);
                    // Back-compat to play well with older client.
                    if (helpMessage.version) {
                        helpContent = helpMessage.tasks.map((task: string) => `chain-${task}`);
                    } else {
                        helpContent = helpMessage.tasks;
                    }

                    await this.trackDocument(helpContent);
                }
            }
        }

        this.context.checkpoint(message);
    }

    // TODO THIS PROBABLY GOES AWAY
    // Sends help message for a task. Uses a rate limiter to limit request per clientId.
    private async trackDocument(helpTasks: string[]): Promise<void> {
        this.generateQueueTasks(helpTasks);
    }

    // From a list of task requests, figure out the queue for the tasks and return a map of <queue, takss[]>
    private generateQueueTasks(tasks: string[]): Map<string, string[]> {
        // Figure out the queue for each task and populate the map.
        const queueTaskMap = new Map<string, string[]>();
        for (const task of tasks) {
            const queue = this.taskQueueMap.get(task);
            if (queue) {
                let queueTasks = queueTaskMap.get(queue);
                if (!queueTasks) {
                    queueTasks = [];
                    queueTaskMap.set(queue, queueTasks);
                }
                queueTasks.push(task);
            }
        }
        return queueTaskMap;
    }
}
