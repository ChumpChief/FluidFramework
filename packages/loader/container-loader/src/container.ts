/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IRequest, IResponse } from "@fluidframework/core-interfaces";
import {
    IConnectionDetails,
    IRuntime,
    IRuntimeFactory,
} from "@fluidframework/container-definitions";
import {
    IDocumentDeltaStorageService,
    IDocumentDeltaService,
    IDocumentStorageService,
} from "@fluidframework/driver-definitions";
import {
    isSystemMessage,
} from "@fluidframework/protocol-base";
import {
    IClientJoin,
    ISequencedDocumentMessage,
    ISequencedDocumentSystemMessage,
    MessageType,
} from "@fluidframework/protocol-definitions";

import { DeltaManager } from "./deltaManager";

export class Container {
    private pendingClientId: string | undefined;

    private _clientId: string | undefined;
    private readonly _deltaManager: DeltaManager;

    private _runtime: IRuntime | undefined;
    private get runtime() {
        if (this._runtime === undefined) {
            throw new Error("Attempted to access runtime before it was defined");
        }
        return this._runtime;
    }

    constructor(
        deltaService: IDocumentDeltaService,
        deltaStorageService: IDocumentDeltaStorageService,
    ) {
        this._deltaManager = new DeltaManager(
            deltaService,
            deltaStorageService,
        );

        this._deltaManager.on("connect", (details: IConnectionDetails) => {
            // Stash the clientID to detect when transitioning from connecting (socket.io channel open) to connected
            // (have received the join message for the client ID)
            // This is especially important in the reconnect case. It's possible there could be outstanding
            // ops sent by this client, so we should keep the old client id until we see our own client's
            // join message. after we see the join message for out new connection with our new client id,
            // we know there can no longer be outstanding ops that we sent with the previous client id.
            this.pendingClientId = details.clientId;
        });
    }

    public async request(path: IRequest): Promise<IResponse> {
        return this.runtime.request(path);
    }

    /**
     * Load container.
     */
    public async load(
        containerRuntimeFactory: IRuntimeFactory,
        storageService: IDocumentStorageService,
    ) {
        const submitMessage = (contents: any): number => {
            return this._deltaManager.submit(MessageType.Operation, contents);
        };

        const processRemoteMessage = (message: ISequencedDocumentMessage): void => {
            const local = this._clientId === message.clientId;

            // Forward non system messages to the loaded runtime for processing
            if (!isSystemMessage(message)) {
                this.runtime.process(message, local);
            }

            // Leftover from quorum's addMember
            // Maybe push down into the socket driver?
            if (message.type === MessageType.ClientJoin) {
                const joinMessage = message as ISequencedDocumentSystemMessage;
                const join = JSON.parse(joinMessage.data) as IClientJoin;
                if (join.clientId === this.pendingClientId) {
                    this._clientId = this.pendingClientId;
                    this.runtime.setConnectionState(true);
                }
            }
        };

        // Start websocket connection as soon as possible. Note that there is no op handler attached yet, but the
        // DeltaManager is resilient to this and will wait to start processing ops until after it is attached.
        const startConnectionP = this._deltaManager.connect();

        // Attach op handlers to start processing ops
        this._deltaManager.attachOpHandler({
            process: processRemoteMessage,
        });
        const existing = await startConnectionP.then((details) => details.existing);

        this._runtime = await containerRuntimeFactory.instantiateRuntime(
            existing,
            submitMessage,
            storageService,
        );

        // The queues start paused
        this._deltaManager.resume();
    }
}
