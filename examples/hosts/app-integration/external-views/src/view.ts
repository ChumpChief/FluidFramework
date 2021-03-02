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
    rollButton.disabled = true;
    // Call the roll method to modify the shared data when the button is clicked.
    rollButton.addEventListener("click", diceRoller.roll);
    diceRoller.on("rollLeadershipChanged", () => {
        rollButton.disabled = !diceRoller.hasRollLeadership;
    });

    const taskManager = diceRoller.taskManager;
    if (taskManager === undefined) {
        throw new Error("Task queue undefined");
    }
    const taskQueues = taskManager.getTaskQueues();

    const taskManagerView = document.createElement("div");
    function renderTaskManager() {
        // eslint-disable-next-line no-null/no-null
        while (taskManagerView.firstChild !== null) {
            taskManagerView.removeChild(taskManagerView.firstChild);
        }
        for (const [taskId, clientQueue] of taskQueues) {
            console.log([taskId, clientQueue]);
            const taskView = document.createElement("div");
            taskView.textContent = `${taskId}: ${clientQueue}`;
            taskManagerView.append(taskView);
        }
    }
    renderTaskManager();
    taskManager.on("changed", renderTaskManager);

    const taskButtonView = document.createElement("div");
    const autoRollVolunteerBtn = document.createElement("button");
    autoRollVolunteerBtn.textContent = "Volunteer (AutoRoll)";
    autoRollVolunteerBtn.addEventListener("click", () => {
        diceRoller.volunteerAutoRoll().catch((err) => { console.error(err); });
    });

    const rollLeadershipVolunteerBtn = document.createElement("button");
    rollLeadershipVolunteerBtn.textContent = "Volunteer (RollLeadership)";
    rollLeadershipVolunteerBtn.addEventListener("click", () => {
        diceRoller.volunteerRollLeadership().catch((err) => { console.error(err); });
    });

    const autoRollAbandonrBtn = document.createElement("button");
    autoRollAbandonrBtn.textContent = "Abandon (AutoRoll)";
    autoRollAbandonrBtn.addEventListener("click", () => {
        diceRoller.abandonAutoRoll();
    });

    const rollLeadershipAbandonBtn = document.createElement("button");
    rollLeadershipAbandonBtn.textContent = "Abandon (RollLeadership)";
    rollLeadershipAbandonBtn.addEventListener("click", () => {
        diceRoller.abandonRollLeadership();
    });

    taskButtonView.append(
        autoRollVolunteerBtn,
        rollLeadershipVolunteerBtn,
        autoRollAbandonrBtn,
        rollLeadershipAbandonBtn,
    );

    wrapperDiv.append(diceCharDiv, rollButton, taskManagerView, taskButtonView);

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
