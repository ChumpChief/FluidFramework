/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ICollection } from "./database";

export interface IDb {
    close(): Promise<void>;

    on(event: string, listener: (...args: any[]) => void);

    collection<T>(name: string): ICollection<T>;
}

export interface IDbFactory {
    connect(): Promise<IDb>;
}

/**
 * Helper class to manage access to a MongoDb database
 */
export class MongoManager {
    private databaseP: Promise<IDb>;

    constructor(
        private readonly factory: IDbFactory,
        private shouldReconnect = true,
        private readonly reconnectDelayMs = 1000) {
        this.databaseP = this.connect();
    }

    /**
     * Retrieves the MongoDB database
     */
    public async getDatabase(): Promise<IDb> {
        return this.databaseP;
    }

    /**
     * Closes the connection to MongoDB
     */
    public async close(): Promise<void> {
        this.shouldReconnect = false;
        const database = await this.databaseP;
        return database.close();
    }

    /**
     * Creates a connection to the MongoDB database
     */
    private async connect(): Promise<IDb> {
        const databaseP = this.factory.connect()
            .then((db) => {
                db.on("error", (error) => {
                    this.reconnect(this.reconnectDelayMs);
                });

                db.on("close", (value) => {
                    this.reconnect(this.reconnectDelayMs);
                });

                return db;
            });

        databaseP.catch((error) => {
            this.reconnect(this.reconnectDelayMs);
        });

        return databaseP;
    }

    /**
     * Reconnects to MongoDb
     */
    private reconnect(delay) {
        if (!this.shouldReconnect) {
            return;
        }

        this.databaseP = new Promise<IDb>((resolve) => {
            setTimeout(
                () => {
                    const connectP = this.connect();
                    resolve(connectP);
                },
                delay);
        });
    }
}
