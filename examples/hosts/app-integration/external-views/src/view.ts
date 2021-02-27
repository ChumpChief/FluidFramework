/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

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

    const taskQueue = diceRoller.taskQueue;
    if (taskQueue === undefined) {
        throw new Error("Task queue undefined");
    }
    const taskQueues = taskQueue.getTaskQueues();

    const taskQueueView = document.createElement("div");
    function renderTaskQueues() {
        // eslint-disable-next-line no-null/no-null
        while (taskQueueView.firstChild !== null) {
            taskQueueView.removeChild(taskQueueView.firstChild);
        }
        for (const [taskId, clientQueue] of taskQueues) {
            console.log([taskId, clientQueue]);
            const taskView = document.createElement("div");
            taskView.textContent = `${taskId}: ${clientQueue}`;
            taskQueueView.append(taskView);
        }
    }
    renderTaskQueues();
    taskQueue.on("changed", renderTaskQueues);

    const taskButtonView = document.createElement("div");
    const fooVolunteerBtn = document.createElement("button");
    fooVolunteerBtn.textContent = "Volunteer (foo)";
    fooVolunteerBtn.addEventListener("click", () => {
        taskQueue.volunteer("foo");
    });

    const barVolunteerBtn = document.createElement("button");
    barVolunteerBtn.textContent = "Volunteer (bar)";
    barVolunteerBtn.addEventListener("click", () => {
        taskQueue.volunteer("bar");
    });

    const fooAbandonrBtn = document.createElement("button");
    fooAbandonrBtn.textContent = "Abandon (foo)";
    fooAbandonrBtn.addEventListener("click", () => {
        taskQueue.abandon("foo");
    });

    const barAbandonBtn = document.createElement("button");
    barAbandonBtn.textContent = "Abandon (bar)";
    barAbandonBtn.addEventListener("click", () => {
        taskQueue.abandon("bar");
    });
    taskButtonView.append(fooVolunteerBtn, barVolunteerBtn, fooAbandonrBtn, barAbandonBtn);

    wrapperDiv.append(diceCharDiv, rollButton, taskQueueView, taskButtonView);

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
