/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDocumentStorage,
    MongoManager,
} from "@fluidframework/server-services-core";
import * as bodyParser from "body-parser";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Router } from "express";
import safeStringify from "json-stringify-safe";
import { create as createRoutes } from "./routes";

export function createExpressApp(
    storage: IDocumentStorage,
    mongoManager: MongoManager,
) {
    // Maximum REST request size
    // hard coded from config
    const requestSize = undefined;

    // Express app configuration
    const expressApp = express();

    // Running behind iisnode
    expressApp.set("trust proxy", 1);

    expressApp.use(compression());

    expressApp.use(cookieParser());
    expressApp.use(bodyParser.json({ limit: requestSize }));
    expressApp.use(bodyParser.urlencoded({ limit: requestSize, extended: false }));

    // Bind routes
    const routes = createRoutes(
        mongoManager,
        storage);

    expressApp.use(cors());
    expressApp.use(routes.storage);
    expressApp.use(routes.ordering);

    // Basic Help Message
    expressApp.use(Router().get("/", (req, res) => {
        // eslint-disable-next-line max-len
        res.status(200).send("This is Tinylicious. Learn more at https://github.com/microsoft/FluidFramework/tree/main/server/tinylicious");
    }));

    // Catch 404 and forward to error handler
    expressApp.use((req, res, next) => {
        const err = new Error("Not Found");
        (err as any).status = 404;
        next(err);
    });

    // Error handlers
    expressApp.use((err, req, res, next) => {
        res.status(err.status || 500);
        res.json({ error: safeStringify(err), message: err.message });
    });

    return expressApp;
}
