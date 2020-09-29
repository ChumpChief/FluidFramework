/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { Container, DeltaManager } from "@fluidframework/container-loader";
import {
    IClient,
    MessageType,
} from "@fluidframework/protocol-definitions";
import {
    DocumentDeltaStorageService,
    DocumentDeltaService,
    DocumentStorageService,
} from "@fluidframework/routerlicious-driver";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";

import { diceRollerContainerRuntimeFactory } from "./containerCode";
import { IDiceRoller } from "./dataObject";
import { SocketIODeltaStream } from "./socketIoDeltaStream";
import { renderDiceRoller } from "./view";
import { DeltaStreamManager } from "./deltaStreamManager";

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

// Setting up shared constants
const documentId = location.hash.substring(1);
const encodedDocId = encodeURIComponent(documentId);
const tenantId = "tinylicious";
const ordererUrl = "http://localhost:3000";
const deltaStorageUrl = `http://localhost:3000/deltas/${tenantId}/${encodedDocId}`;
const storageUrl = `http://localhost:3000/repos/${tenantId}`;
const client: IClient = {
    details: {
        capabilities: { interactive: true },
    },
    mode: "write",
    permission: [],
    scopes: [],
    user: { id: "" },
};
// End shared constants

document.title = documentId;

async function startOld(): Promise<void> {
    const token = jwt.sign({
        documentId,
        scopes: ["doc:read", "doc:write", "summary:write"],
        tenantId,
        user: { id: uuid() },
    }, "12345");

    // getTinyliciousContainer start
    const deltaService = new DocumentDeltaService(
        ordererUrl,
        token,
        tenantId,
        documentId,
    );

    const oldDeltaStorageService = new DocumentDeltaStorageService(tenantId, token, deltaStorageUrl);
    const storageService = new DocumentStorageService(documentId, tenantId, token, storageUrl);

    const deltaManager = new DeltaManager(
        deltaService,
        oldDeltaStorageService,
    );

    const container = new Container(
        deltaManager,
    );
    await container.load(
        diceRollerContainerRuntimeFactory,
        storageService,
    );
    // getTinyliciousContainer end

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
    const div = document.getElementById("content1") as HTMLDivElement;
    renderDiceRoller(diceRoller, div);
}
window["startOld"] = startOld;

async function startNew(): Promise<void> {
    const token = jwt.sign({
        documentId,
        scopes: ["doc:read", "doc:write", "summary:write"],
        tenantId,
        user: { id: uuid() },
    }, "12345");

    const deltaStream = new SocketIODeltaStream(documentId, tenantId, ordererUrl);
    window["testDeltaStream"] = deltaStream;

    const deltaStorage = new DocumentDeltaStorageService(
        tenantId,
        token,
        deltaStorageUrl,
    );

    const deltaStreamManager = new DeltaStreamManager(deltaStream, deltaStorage);
    window["testDeltaStreamManager"] = deltaStreamManager;

    deltaStreamManager.on("opsAvailable", () => {
        while (deltaStreamManager.hasAvailableOps()) {
            const nextOp = deltaStreamManager.pullOp();
            // Processing goes here
            console.log(nextOp);
        }
    });

    await deltaStream.connect(tenantId, documentId, token, client);
    console.log("Stream connected, connectionInfo:", deltaStream.connectionInfo);

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

        const submitResultP = deltaStreamManager.submit(
            MessageType.Operation,
            opContent,
        );
        submitResultP
            .then((submitResult) => { console.log(submitResult); })
            .catch((error) => { console.error(error); });
    };
    window["submitRoll"] = submitRoll;

    const documentStorageService = new DocumentStorageService(documentId, tenantId, token, storageUrl);
    window["testDocumentStorageService"] = documentStorageService;

    // Given an IDiceRoller, we can render the value and provide controls for users to roll it.
    const div = document.getElementById("content2") as HTMLDivElement;
    // renderDiceRoller(diceRoller, div);
    console.log(div);
}
window["startNew"] = startNew;

// startOld().catch((error) => console.error(error));

/* eslint-enable dot-notation */
