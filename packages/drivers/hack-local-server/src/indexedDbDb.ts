/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { EventEmitter } from "events";
import { ICollection, IDb } from "@fluidframework/server-services-core";
import { IndexedDbCollection } from "./indexedDbCollection";

/**
 * A database for testing that stores data in the browsers session storage
 */
export class IndexedDbDb extends EventEmitter implements IDb {
    private readonly collections = new Map<string, IndexedDbCollection<any>>();
    public async close(): Promise<void> { }
    public collection<T>(name: string): ICollection<T> {
        if (!this.collections.has(name)) {
            this.collections.set(name, new IndexedDbCollection<T>(name));
        }
        return this.collections.get(name) as IndexedDbCollection<T>;
    }

    public async dropCollection(name: string): Promise<boolean> {
        if (!this.collections.has(name)) {
            return true;
        }
        this.collections.delete(name);
        return true;
    }
}
