/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IClient, ISequencedDocumentMessage, MessageType } from "@fluidframework/protocol-definitions";
import {
    DocumentDeltaStorageService,
    DocumentStorageService,
} from "@fluidframework/routerlicious-driver";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";

import { diceRollerContainerRuntimeFactory } from "./containerCode";
import { IDiceRoller } from "./dataObject";
import { DeltaStreamWriter } from "./deltaStreamWriter";
import { DeltaStreamFollower } from "./deltaStreamFollower";
import { getTinyliciousContainer } from "./getTinyliciousContainer";
import { SocketIODeltaStream } from "./socketIoDeltaStream";
import { renderDiceRoller } from "./view";

/* eslint-disable dot-notation */

// In interacting with the service, we need to be explicit about whether we're creating a new document vs. loading
// an existing one.  We also need to provide the unique ID for the document we are creating or loading from.

// In this app, we'll choose to create a new document when navigating directly to http://localhost:8080.  For the ID,
// we'll choose to use the current timestamp.  We'll also choose to interpret the URL hash as an existing document's
// ID to load from, so the URL for a document load will look something like http://localhost:8080/#1596520748752.
// These policy choices are arbitrary for demo purposes, and can be changed however you'd like.
if (location.hash.length === 0) {
    location.hash = Date.now().toString();
}
const documentId = location.hash.substring(1);
document.title = documentId;

const tenantId = "tinylicious";

const deltaStream = new SocketIODeltaStream(documentId, tenantId, "http://localhost:3000");
window["testDeltaStream"] = deltaStream;

const client: IClient = {
    details: {
        capabilities: { interactive: true },
    },
    mode: "write",
    permission: [],
    scopes: [],
    user: { id: "" },
};
window["oldClient"] = client;

// ITokenClaims
const token = jwt.sign({
    documentId,
    scopes: ["doc:read", "doc:write", "summary:write"],
    tenantId,
    user: { id: uuid() },
}, "12345");
window["oldToken"] = token;

const encodedDocId = encodeURIComponent(documentId);
const deltaStorageUrl = `http://localhost:3000/deltas/tinylicious/${encodedDocId}`;
const deltaStorageService = new DocumentDeltaStorageService(
    tenantId,
    token,
    deltaStorageUrl,
);
const deltaStreamFollower = new DeltaStreamFollower(deltaStream, deltaStorageService, 0);
window["testDeltaStreamFollower"] = deltaStreamFollower;

let lastProcessedOpSequenceNumber = 0;

const handleSequentialOpsAvailable = () => {
    const isOpLocal = (op: ISequencedDocumentMessage) => {
        if (deltaStream.connectionInfo === undefined) {
            throw new Error("Cannot compute local ops when disconnected");
        }
        // TODO this needs something more sophisticated - client ID doesn't persist across reconnect
        return op.clientId === deltaStream.connectionInfo.clientId;
    };

    // Note: op sequence numbers are 1-indexed, is why this works
    while (lastProcessedOpSequenceNumber < deltaStreamFollower.sequentialOps.length) {
        const nextOp = deltaStreamFollower.sequentialOps[lastProcessedOpSequenceNumber];
        // containerRuntime.process(
        //     nextOp,
        //     isOpLocal(nextOp),
        // );
        console.log(nextOp, isOpLocal(nextOp));
        lastProcessedOpSequenceNumber = nextOp.sequenceNumber;
    }
};

deltaStreamFollower.on("sequentialOpsAvailable", handleSequentialOpsAvailable);

const deltaStreamWriter = new DeltaStreamWriter(deltaStream);
window["testDeltaStreamWriter"] = deltaStreamWriter;

const submitRoll = (diceValue: number) => {
    const opContent = {
        type: "component",
        contents: {
            address: "default",
            contents: {
                content: {
                    address: "root",
                    contents: {
                        key: "diceValue",
                        path: "/",
                        type: "set",
                        value: {
                            type: "Plain",
                            value: diceValue,
                        },
                    },
                },
                type: "op",
            },
        },
    };
    console.log(opContent, lastProcessedOpSequenceNumber);

    deltaStreamWriter.submit(
        MessageType.Operation,
        opContent,
        lastProcessedOpSequenceNumber,
    );
};
window["submitRoll"] = submitRoll;

const storageUrl = `http://localhost:3000/repos/tinylicious`;
const documentStorageService = new DocumentStorageService(documentId, tenantId, token, storageUrl);
window["testDocumentStorageService"] = documentStorageService;

const connectTestStream = () => {
    deltaStream.connect(tenantId, documentId, token, client)
        .then(() => console.log("Stream connected, connectionInfo:", deltaStream.connectionInfo))
        .catch((error) => console.error(error));
};
window["connectTestStream"] = connectTestStream;

async function start(): Promise<void> {
    // The getTinyliciousContainer helper function facilitates loading our container code into a Container and
    // connecting to a locally-running test service called Tinylicious.  This will look different when moving to a
    // production service, but ultimately we'll still be getting a reference to a Container object.  The helper
    // function takes the ID of the document we're creating or loading, the container code to load into it, and a
    // flag to specify whether we're creating a new document or loading an existing one.
    const container = await getTinyliciousContainer(documentId, diceRollerContainerRuntimeFactory);

    // Since we're using a ContainerRuntimeFactoryWithDefaultDataStore, our dice roller is available at the URL "/".
    const url = "/";
    const response = await container.request({ url });

    // Verify the response to make sure we got what we expected.
    if (response.status !== 200 || response.mimeType !== "fluid/object") {
        throw new Error(`Unable to retrieve data object at URL: "${url}"`);
    } else if (response.value === undefined) {
        throw new Error(`Empty response from URL: "${url}"`);
    }

    // In this app, we know our container code provides a default data object that is an IDiceRoller.
    const diceRoller: IDiceRoller = response.value;

    // Given an IDiceRoller, we can render the value and provide controls for users to roll it.
    const div = document.getElementById("content") as HTMLDivElement;
    renderDiceRoller(diceRoller, div);
}

start().catch((error) => console.error(error));

/* eslint-enable dot-notation */
