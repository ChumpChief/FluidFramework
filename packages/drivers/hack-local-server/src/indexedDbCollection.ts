/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ICollection } from "@fluidframework/server-services-core";
import { v4 as uuid } from "uuid";

const dbP = new Promise<IDBDatabase>((resolve) => {
    const dbReq = globalThis.indexedDB.open("fluid");
    dbReq.addEventListener("upgradeneeded", () => {
        const db = dbReq.result;
        db.createObjectStore("values", { keyPath: "key" });
    });
    dbReq.addEventListener("success", () => {
        resolve(dbReq.result);
    });
});

/**
 * A collection for IndexedDb storage, where data is stored in the browser
 * Functions include database operations such as queries, insertion and update.
 */
export class IndexedDbCollection<T> implements ICollection<T> {
    constructor(private readonly collectionName: string) { }

    public aggregate(pipeline: any, options?: any): any {
        throw new Error("Method Not Implemented");
    }

    public async updateMany(filter: any, set: any, addToSet: any): Promise<void> {
        throw new Error("Method Not Implemented");
    }
    public async distinct(key: any, query: any): Promise<any> {
        throw new Error("Method Not Implemented");
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.find}
     */
    /*
     * Each query key consists of several keys separated by '.' e.g: "operation.sequenceNumber".
     * The hierarchical syntax allows finding nested key patterns.
     */
    public async find(query: any, sort: any): Promise<any[]> {
        // split the keys and get the corresponding value
        function getValueByKey(propertyBag, key: string) {
            const keys = key.split(".");
            let value = propertyBag;
            keys.forEach((splitKey) => {
                value = value[splitKey];
            });
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return value;
        }

        // getting keys of the query we are trying to find
        const queryKeys = Object.keys(query);
        let filteredCollection = await this.getAllInternal();
        queryKeys.forEach((key) => {
            if (!query[key]) {
                return;
            }
            if (query[key].$gt > 0 || query[key].$lt > 0) {
                if (query[key].$gt > 0) {
                    filteredCollection = filteredCollection.filter(
                        (value) => getValueByKey(value, key) > query[key].$gt);
                }
                if (query[key].$lt > 0) {
                    filteredCollection = filteredCollection.filter(
                        (value) => getValueByKey(value, key) < query[key].$lt);
                }
            } else {
                filteredCollection = filteredCollection.filter(
                    (value) => getValueByKey(value, key) === query[key]);
            }
        });

        if (sort && Object.keys(sort).length === 1) {
            // eslint-disable-next-line no-inner-declarations
            function compare(a, b) {
                const sortKey = Object.keys(sort)[0];
                return sort[sortKey] === 1
                    ? getValueByKey(a, sortKey) - getValueByKey(b, sortKey)
                    : getValueByKey(b, sortKey) - getValueByKey(a, sortKey);
            }

            filteredCollection = filteredCollection.sort(compare);
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return filteredCollection;
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.findAll}
     */
    public async findAll(): Promise<any[]> {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return this.getAllInternal();
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.findOne}
     */
    /*
     * Query is expected to have a member "_id" which is a string used to find value in the database.
     */
    public async findOne(query: any): Promise<any> {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return this.findOneInternal(query);
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.update}
     */
    /*
     * Query is expected to have a member "_id" which is a string used to find value in the database.
     */
    public async update(query: any, set: any, addToSet: any): Promise<void> {
        const value = await this.findOneInternal(query);
        if (!value) {
            throw new Error("Not found");
        } else {
            for (const key of Object.keys(set)) {
                value[key] = set[key];
            }
            return this.insertInternal(value);
        }
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.upsert}
     */
    /*
     * Query is expected to have a member "_id" which is a string used to find value in the database.
     */
    public async upsert(query: any, set: any, addToSet: any): Promise<void> {
        const value = await this.findOneInternal(query);
        if (!value) {
            return this.insertInternal(set);
        } else {
            for (const key of Object.keys(set)) {
                value[key] = set[key];
            }
            return this.insertInternal(value);
        }
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.insertOne}
     */
    /*
     * Value is expected to have a member "_id" which is a string used to search in the database.
     */
    public async insertOne(value: any): Promise<any> {
        const presentVal = await this.findOneInternal(value);
        // Only raise error when the object is present and the value is not equal.
        if (presentVal) {
            if (JSON.stringify(presentVal) === JSON.stringify(value)) {
                return;
            }
            throw new Error("Existing Object!!");
        }

        return this.insertInternal(value);
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.findOrCreate}
     */
    /*
     * Value and query are expected to have a member "_id" which is a string used to search or insert in the database.
     */
    public async findOrCreate(query: any, value: any): Promise<{ value: any; existing: boolean; }> {
        const existing = await this.findOneInternal(query);
        if (existing) {
            return { value: existing, existing: true };
        }
        await this.insertInternal(value);
        return { value, existing: false };
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.insertMany}
     */
    /*
     * Each element in values is expected to have a member "_id" which is a string used to insert in the database.
     */
    public async insertMany(values: any[], ordered: boolean): Promise<void> {
        return this.insertInternal(...values);
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.deleteOne}
     */
    public async deleteOne(query: any): Promise<any> {
        throw new Error("Method not implemented.");
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.deleteMany}
     */
    public async deleteMany(query: any): Promise<any> {
        throw new Error("Method not implemented.");
    }

    /**
     * {@inheritDoc @fluidframework/server-services-core#ICollection.createIndex}
     */
    public async createIndex(index: any, unique: boolean): Promise<void> {
        throw new Error("Method not implemented.");
    }

    /**
     * Return all values in the database
     */
    private async getAllInternal(): Promise<any[]> {
        const db = await dbP;
        const transaction = db.transaction(["values"], "readonly");
        const valuesObjectStore = transaction.objectStore("values");

        const getResults = await new Promise<{ key: string; value: string; }[]>((resolve) => {
            const request = valuesObjectStore.getAll(
                IDBKeyRange.bound(this.collectionName, `${this.collectionName}\uffff"`),
            );
            const successListener = () => {
                resolve(request.result);
                request.removeEventListener("success", successListener);
            };
            request.addEventListener("success", successListener);
        });

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return getResults.map((result) => JSON.parse(result.value));
    }

    /**
     * Inserts values into the session storge.
     * Values are expected to have a member "_id" which is a unique id, otherwise will be assigned one
     *
     * @param values - data to insert to the database
     */
    private async insertInternal(...values: any[]) {
        const db = await dbP;
        const transaction = db.transaction(["values"], "readwrite");
        const valuesObjectStore = transaction.objectStore("values");
        const putPs: Promise<void>[] = [];
        for (const value of values) {
            if (!value._id) {
                value._id = uuid();
            }

            putPs.push(new Promise<void>((resolve) => {
                const request = valuesObjectStore.put({
                    key: `${this.collectionName}-${value._id}`,
                    value: JSON.stringify(value),
                });
                const successListener = () => {
                    resolve();
                    request.removeEventListener("success", successListener);
                };
                request.addEventListener("success", successListener);
            }));
        }
        await Promise.all(putPs);
    }

    /**
     * Finds the query in IndexedDb storage and returns its value.
     * Returns null if query is not found.
     * Query is expected to have a member "_id" which is a unique id.
     *
     * @param query - what to find in the database
     */
    private async findOneInternal(query: any): Promise<any> {
        const db = await dbP;
        const transaction = db.transaction(["values"], "readonly");
        const valuesObjectStore = transaction.objectStore("values");

        if (query._id) {
            const getResult = await new Promise<{ key: string; value: string; } | undefined>((resolve) => {
                const request = valuesObjectStore.get(`${this.collectionName}-${query._id}`);
                const successListener = () => {
                    resolve(request.result);
                    request.removeEventListener("success", successListener);
                };
                request.addEventListener("success", successListener);
            });
            if (getResult !== undefined) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                return JSON.parse(getResult.value);
            }
        } else {
            const allValues = await this.getAllInternal();
            const queryKeys = Object.keys(query);
            for (const value of allValues) {
                let foundMismatch = false;
                for (const qk of queryKeys) {
                    if (value[qk] !== query[qk]) {
                        foundMismatch = true;
                        break;
                    }
                }
                if (!foundMismatch) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                    return value;
                }
            }
        }
        return null;
    }
}
