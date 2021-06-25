/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { getExperimentalContainer, TinyliciousService } from "@fluid-experimental/get-container";

import { DiceRollerContainerRuntimeFactory } from "./containerCode";
import { IDiceRoller } from "./dataObject";
import { renderConnectionControls, renderDiceRoller } from "./view";

let createNew = false;
if (location.hash.length === 0) {
    createNew = true;
    location.hash = Date.now().toString();
}
const documentId = location.hash.substring(1);
document.title = documentId;

async function start(): Promise<void> {
    const service = new TinyliciousService();
    const container = await getExperimentalContainer(
        service,
        documentId,
        DiceRollerContainerRuntimeFactory,
        createNew,
    );
    // eslint-disable-next-line @typescript-eslint/dot-notation
    window["container"] = container;

    // Maybe would be better to pass in the stateful connection (so the host can bring their own connection policy)?

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

    if (container.connectionManager === undefined) {
        throw new Error("Should have a connection manager at this point");
    }

    // Given an IDiceRoller, we can render the value and provide controls for users to roll it.
    const contentDiv = document.getElementById("content") as HTMLDivElement;
    const diceRollerDiv = document.createElement("div");
    const connectionControlsDiv = document.createElement("div");
    contentDiv.append(diceRollerDiv, connectionControlsDiv);
    renderDiceRoller(diceRoller, diceRollerDiv);
    renderConnectionControls(container.connectionManager, connectionControlsDiv);
}

start().catch((error) => console.error(error));
