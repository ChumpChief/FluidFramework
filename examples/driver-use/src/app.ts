/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IClient } from "@fluidframework/protocol-definitions";
import {
    DocumentDeltaStorageService,
    DocumentStorageService,
} from "@fluidframework/routerlicious-driver";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";

import { DiceRollerContainerRuntimeFactory } from "./containerCode";
import { IDiceRoller } from "./dataObject";
import { DeltaFeedCommunicator } from "./deltaFeedCommunicator";
import { DeltaFeedFollower } from "./deltaFeedFollower";
import { getTinyliciousContainer } from "./getTinyliciousContainer";
import { SocketIODeltaFeed } from "./socketIoDeltaFeed";
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

const deltaFeed = new SocketIODeltaFeed(documentId, tenantId, "http://localhost:3000");
window["testDeltaFeed"] = deltaFeed;

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
const deltaFeedFollower = new DeltaFeedFollower(deltaFeed, deltaStorageService, 0);
window["testDeltaFeedFollower"] = deltaFeedFollower;

const deltaFeedCommunicator = new DeltaFeedCommunicator(deltaFeedFollower);
window["testDeltaFeedCommunicator"] = deltaFeedCommunicator;

const storageUrl = `http://localhost:3000/repos/tinylicious`;
const documentStorageService = new DocumentStorageService(documentId, tenantId, token, storageUrl);
window["testDocumentStorageService"] = documentStorageService;

const connectTestFeed = () => {
    deltaFeed.connect(tenantId, documentId, token, client)
        .then(() => console.log("Feed connected"))
        .catch((error) => console.error(error));
};
window["connectTestFeed"] = connectTestFeed;

async function start(): Promise<void> {
    // The getTinyliciousContainer helper function facilitates loading our container code into a Container and
    // connecting to a locally-running test service called Tinylicious.  This will look different when moving to a
    // production service, but ultimately we'll still be getting a reference to a Container object.  The helper
    // function takes the ID of the document we're creating or loading, the container code to load into it, and a
    // flag to specify whether we're creating a new document or loading an existing one.
    const container = await getTinyliciousContainer(documentId, DiceRollerContainerRuntimeFactory);

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
