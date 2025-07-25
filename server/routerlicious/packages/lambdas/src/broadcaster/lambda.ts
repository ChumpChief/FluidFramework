/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	type INack,
	type ISequencedDocumentMessage,
	type ISignalClient,
	type ISignalMessage,
	MessageType,
} from "@fluidframework/protocol-definitions";
import {
	extractBoxcar,
	type IClientManager,
	type IContext,
	type IMessageBatch,
	type INackMessage,
	type IPartitionLambda,
	type IPublisher,
	type IQueuedMessage,
	type ISequencedOperationMessage,
	type IServiceConfiguration,
	type ITicketedSignalMessage,
	NackOperationType,
	SequencedOperationType,
	SignalOperationType,
} from "@fluidframework/server-services-core";

/**
 * Container for a batch of messages being sent for a specific tenant/document id
 */
type BroadcasterMessageBatch = IMessageBatch<ISequencedDocumentMessage | INack | ISignalMessage>;

// Set immediate is not available in all environments, specifically it does not work in a browser.
// Fallback to set timeout in those cases
let taskScheduleFunction: (cb: () => any) => unknown;
let clearTaskScheduleTimerFunction: (timer: any) => void;

if (typeof setImmediate === "function") {
	taskScheduleFunction = setImmediate;
	clearTaskScheduleTimerFunction = clearImmediate;
} else {
	taskScheduleFunction = setTimeout;
	clearTaskScheduleTimerFunction = clearTimeout;
}

/**
 * @internal
 */
export class BroadcasterLambda implements IPartitionLambda {
	private pending = new Map<string, BroadcasterMessageBatch>();
	private pendingOffset: IQueuedMessage | undefined;
	private current = new Map<string, BroadcasterMessageBatch>();
	private messageSendingTimerId: unknown | undefined;

	constructor(
		private readonly publisher: IPublisher<ISequencedDocumentMessage | INack | ISignalMessage>,
		private readonly context: IContext,
		private readonly serviceConfiguration: IServiceConfiguration,
		private readonly clientManager: IClientManager | undefined,
	) {}

	/**
	 * {@inheritDoc IPartitionLambda.handler}
	 */
	public async handler(message: IQueuedMessage): Promise<void> {
		const boxcar = extractBoxcar(message);

		for (const baseMessage of boxcar.contents) {
			let topic: string | undefined;
			let event: string | undefined;

			switch (baseMessage.type) {
				case SequencedOperationType: {
					event = "op";

					const sequencedOperationMessage = baseMessage as ISequencedOperationMessage;
					topic = `${sequencedOperationMessage.tenantId}/${sequencedOperationMessage.documentId}`;
					break;
				}

				case NackOperationType: {
					event = "nack";

					const nackMessage = baseMessage as INackMessage;
					topic = `client#${nackMessage.clientId}`;
					break;
				}

				case SignalOperationType: {
					event = "signal";

					const ticketedSignalMessage = baseMessage as ITicketedSignalMessage;
					topic = `${ticketedSignalMessage.tenantId}/${ticketedSignalMessage.documentId}`;

					if (this.clientManager && ticketedSignalMessage.operation) {
						const signalContent = JSON.parse(
							ticketedSignalMessage.operation.content as string,
						);
						const signalType: MessageType | undefined =
							typeof signalContent.type === "string" ? signalContent.type : undefined;
						switch (signalType) {
							case MessageType.ClientJoin: {
								const signalClient: ISignalClient = signalContent.content;
								await this.clientManager.addClient(
									ticketedSignalMessage.tenantId,
									ticketedSignalMessage.documentId,
									signalClient.clientId,
									signalClient.client,
									ticketedSignalMessage.operation,
								);
								break;
							}

							case MessageType.ClientLeave: {
								await this.clientManager.removeClient(
									ticketedSignalMessage.tenantId,
									ticketedSignalMessage.documentId,
									signalContent.content,
									ticketedSignalMessage.operation,
								);
								break;
							}

							default: {
								// ignore unknown types
								break;
							}
						}
					}

					break;
				}

				default: {
					// ignore unknown types
					continue;
				}
			}

			const value = baseMessage as
				| INackMessage
				| ISequencedOperationMessage
				| ITicketedSignalMessage;

			if (
				value.type === SequencedOperationType &&
				value.operation?.traces &&
				value.operation.traces.length > 0
			) {
				value.operation.traces.push({
					action: "start",
					service: "broadcaster",
					timestamp: Date.now(),
				});
			}

			if (this.serviceConfiguration.broadcaster.includeEventInMessageBatchName) {
				topic += event;
			}

			let pendingBatch = this.pending.get(topic);
			if (pendingBatch) {
				pendingBatch.messages.push(value.operation);
			} else {
				pendingBatch = {
					tenantId: value.tenantId,
					documentId: value.documentId,
					event,
					messages: [value.operation],
				};
				this.pending.set(topic, pendingBatch);
			}
		}

		this.pendingOffset = message;
		this.sendPending();
	}

	public close(): void {
		this.pending.clear();
		this.current.clear();
		this.pendingOffset = undefined;

		if (this.messageSendingTimerId !== undefined) {
			clearTaskScheduleTimerFunction(this.messageSendingTimerId);
			this.messageSendingTimerId = undefined;
		}
	}

	public hasPendingWork(): boolean {
		return this.pending.size > 0 || this.current.size > 0;
	}

	private sendPending(): void {
		if (this.messageSendingTimerId !== undefined) {
			// a send is in progress
			return;
		}

		if (this.pending.size === 0) {
			// no pending work. checkpoint now if we have a pending offset
			if (this.pendingOffset) {
				this.context.checkpoint(this.pendingOffset);
				this.pendingOffset = undefined;
			}
			return;
		}

		// Invoke the next send after a delay to give IO time to create more batches
		this.messageSendingTimerId = taskScheduleFunction(async () => {
			const batchOffset = this.pendingOffset;

			this.current = this.pending;
			this.pending = new Map<string, BroadcasterMessageBatch>();
			this.pendingOffset = undefined;

			// Process all the batches + checkpoint
			if (this.publisher.emitBatch) {
				const promises: Promise<void>[] = [];

				for (const [topic, batch] of this.current) {
					promises.push(this.publisher.emitBatch(topic, batch));
				}

				try {
					await Promise.all(promises);
				} catch (error) {
					this.context.error(error, { restart: true });
					return;
				}
			} else if (this.publisher.emit) {
				const promises: Promise<void>[] = [];

				for (const [topic, batch] of this.current) {
					promises.push(
						this.publisher.emit(topic, batch.event, batch.documentId, batch.messages),
					);
				}

				try {
					await Promise.all(promises);
				} catch (error) {
					this.context.error(error, { restart: true });
					return;
				}
			} else {
				for (const [topic, batch] of this.current) {
					this.publisher.to(topic).emit(batch.event, batch.documentId, batch.messages);
				}
			}

			this.messageSendingTimerId = undefined;

			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			this.context.checkpoint(batchOffset!);
			this.current.clear();
			this.sendPending();
		});
	}
}
