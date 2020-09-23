/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IEventProvider, IErrorEvent } from "@fluidframework/common-definitions";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IDocumentMessage, MessageType } from "@fluidframework/protocol-definitions";

import { IDeltaStream } from "./socketIoDeltaStream";

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaStreamWriterEvents extends IErrorEvent {
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IDeltaStreamWriter extends IEventProvider<IDeltaStreamWriterEvents> {
}

// This is now protocol layer?  Does this really need to exist as a separate object?
export class DeltaStreamWriter
    extends TypedEventEmitter<IDeltaStreamWriterEvents>
    implements IDeltaStreamWriter {
    private clientSequenceNumber: number = 0;
    constructor(
        private readonly deltaStream: IDeltaStream,
    ) {
        super();
    }

    // TODO contents should be Jsonable, not any
    public submit(type: MessageType, contents: any, referenceSequenceNumber: number) {
        const message: IDocumentMessage = {
            clientSequenceNumber: ++this.clientSequenceNumber,
            contents: JSON.stringify(contents),
            referenceSequenceNumber,
            type,
        };
        this.deltaStream.submit(message);
        return this.clientSequenceNumber;
    }
}
