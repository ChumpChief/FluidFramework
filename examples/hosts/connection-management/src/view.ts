/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { StatefulDocumentDeltaConnectionManager } from "@fluid-experimental/experimental-container-loader";
import { IDiceRoller } from "./dataObject";

/**
 * Render an IDiceRoller into a given div as a text character, with a button to roll it.
 * @param diceRoller - The Data Object to be rendered
 * @param div - The div to render into
 */
export function renderDiceRoller(diceRoller: IDiceRoller, div: HTMLDivElement) {
    const wrapperDiv = document.createElement("div");
    wrapperDiv.style.textAlign = "center";
    div.append(wrapperDiv);

    const diceCharDiv = document.createElement("div");
    diceCharDiv.style.fontSize = "200px";

    const rollButton = document.createElement("button");
    rollButton.style.fontSize = "50px";
    rollButton.textContent = "Roll";
    // Call the roll method to modify the shared data when the button is clicked.
    rollButton.addEventListener("click", diceRoller.roll);

    wrapperDiv.append(diceCharDiv, rollButton);

    // Get the current value of the shared data to update the view whenever it changes.
    const updateDiceChar = () => {
        // Unicode 0x2680-0x2685 are the sides of a dice (⚀⚁⚂⚃⚄⚅)
        diceCharDiv.textContent = String.fromCodePoint(0x267F + diceRoller.value);
        diceCharDiv.style.color = `hsl(${diceRoller.value * 60}, 70%, 50%)`;
    };
    updateDiceChar();

    // Use the diceRolled event to trigger the rerender whenever the value changes.
    diceRoller.on("diceRolled", updateDiceChar);
}

export function renderConnectionControls(
    connectionManager: StatefulDocumentDeltaConnectionManager,
    div: HTMLDivElement,
) {
    const wrapperDiv = document.createElement("div");
    wrapperDiv.style.textAlign = "center";

    const connectButton = document.createElement("button");
    connectButton.textContent = "connectionManager.connect()";
    connectButton.addEventListener("click", () => { connectionManager.connect().catch(console.error); });

    const disconnectButton = document.createElement("button");
    disconnectButton.textContent = "connectionManager.disconnect()";
    disconnectButton.addEventListener("click", () => { connectionManager.disconnect(); });

    const setAutoReconnectModeTrueButton = document.createElement("button");
    setAutoReconnectModeTrueButton.textContent = "connectionManager.setAutoReconnectMode(true)";
    setAutoReconnectModeTrueButton.addEventListener("click", () => { connectionManager.setAutoReconnectMode(true); });

    const setAutoReconnectModeFalseButton = document.createElement("button");
    setAutoReconnectModeFalseButton.textContent = "connectionManager.setAutoReconnectMode(false)";
    setAutoReconnectModeFalseButton.addEventListener("click", () => { connectionManager.setAutoReconnectMode(false); });

    const setReadonlyModeTrueButton = document.createElement("button");
    setReadonlyModeTrueButton.textContent = "connectionManager.setReadonlyMode(true)";
    setReadonlyModeTrueButton.addEventListener("click", () => {
        connectionManager.setReadonlyMode(true).catch(console.error);
    });

    const setReadonlyModeFalseButton = document.createElement("button");
    setReadonlyModeFalseButton.textContent = "connectionManager.setReadonlyMode(false)";
    setReadonlyModeFalseButton.addEventListener("click", () => {
        connectionManager.setReadonlyMode(false).catch(console.error);
    });

    wrapperDiv.append(
        connectButton,
        document.createElement("br"),
        disconnectButton,
        document.createElement("br"),
        setAutoReconnectModeTrueButton,
        document.createElement("br"),
        setAutoReconnectModeFalseButton,
        document.createElement("br"),
        setReadonlyModeTrueButton,
        document.createElement("br"),
        setReadonlyModeFalseButton,
    );
    div.append(wrapperDiv);
}
