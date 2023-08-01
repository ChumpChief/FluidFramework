/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IProtocolHandler, IQuorumSnapshot } from "@fluidframework/protocol-base";
import { IDocumentAttributes } from "@fluidframework/protocol-definitions";

// "term" was an experimental feature that is being removed.  The only safe value to use is 1.
export const OnlyValidTermValue = 1 as const;

/**
 * Function to be used for creating a protocol handler.
 */
export type ProtocolHandlerBuilder = (
	attributes: IDocumentAttributes,
	snapshot: IQuorumSnapshot,
	sendProposal: (key: string, value: any) => number,
) => IProtocolHandler;
