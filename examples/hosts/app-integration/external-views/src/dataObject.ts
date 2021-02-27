/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import { TaskQueue } from "@fluid-experimental/task-queue";
import { DataObject, DataObjectFactory } from "@fluidframework/aqueduct";
import { IFluidHandle } from "@fluidframework/core-interfaces";

/**
 * IDiceRoller describes the public API surface for our dice roller data object.
 */
export interface IDiceRoller extends EventEmitter {
    /**
     * Get the dice value as a number.
     */
    readonly value: number;

    taskQueue: TaskQueue | undefined;

    /**
     * Roll the dice.  Will cause a "diceRolled" event to be emitted.
     */
    roll: () => void;

    /**
     * The diceRolled event will fire whenever someone rolls the device, either locally or remotely.
     */
    on(event: "diceRolled", listener: () => void): this;
}

// The root is map-like, so we'll use this key for storing the value.
const diceValueKey = "diceValue";

const taskQueueKey = "taskQueue";

/**
 * The DiceRoller is our data object that implements the IDiceRoller interface.
 */
export class DiceRoller extends DataObject implements IDiceRoller {
    // TODO remove again
    public taskQueue: TaskQueue | undefined;
    private rollTimer: ReturnType<typeof setInterval> | undefined;
    /**
     * initializingFirstTime is run only once by the first client to create the DataObject.  Here we use it to
     * initialize the state of the DataObject.
     */
    protected async initializingFirstTime() {
        this.root.set(diceValueKey, 1);
        const taskQueue = TaskQueue.create(this.runtime);
        this.root.set(taskQueueKey, taskQueue.handle);
    }

    /**
     * hasInitialized is run by each client as they load the DataObject.  Here we use it to set up usage of the
     * DataObject, by registering an event listener for dice rolls.
     */
    protected async hasInitialized() {
        this.root.on("valueChanged", (changed) => {
            if (changed.key === diceValueKey) {
                // When we see the dice value change, we'll emit the diceRolled event we specified in our interface.
                this.emit("diceRolled");
            }
        });

        const taskQueueHandle = this.root.get<IFluidHandle<TaskQueue>>(taskQueueKey);
        this.taskQueue = await taskQueueHandle?.get();
        if (this.taskQueue === undefined) {
            throw new Error("Task queue should be defined by now");
        }
        // eslint-disable-next-line @typescript-eslint/dot-notation
        if (window["taskQueue"] === undefined) {
            // eslint-disable-next-line @typescript-eslint/dot-notation
            window["taskQueue"] = this.taskQueue;
        }

        this.taskQueue.on("assigned", (taskId) => {
            if (taskId === "foo") {
                console.log("Starting roll task");
                if (this.rollTimer !== undefined) {
                    throw new Error("Unexpected defined rollTimer");
                }
                this.rollTimer = setInterval(() => {
                    this.roll();
                }, 1000);
            }
        });

        this.taskQueue.on("lost", (taskId) => {
            if (taskId === "foo") {
                console.log("Ending roll task");
                if (this.rollTimer === undefined) {
                    throw new Error("Unexpected undefined rollTimer");
                }
                clearInterval(this.rollTimer);
                this.rollTimer = undefined;
            }
        });
    }

    public get value() {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return this.root.get(diceValueKey);
    }

    public readonly roll = () => {
        const rollValue = Math.floor(Math.random() * 6) + 1;
        this.root.set(diceValueKey, rollValue);
    };
}

/**
 * The DataObjectFactory is used by Fluid Framework to instantiate our DataObject.  We provide it with a unique name
 * and the constructor it will call.  In this scenario, the third and fourth arguments are not used.
 */
export const DiceRollerInstantiationFactory = new DataObjectFactory(
    "dice-roller",
    DiceRoller,
    [TaskQueue.getFactory()],
    {},
);
