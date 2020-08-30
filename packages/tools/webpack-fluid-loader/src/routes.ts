/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import fs from "fs";
import path from "path";
import express from "express";
import nconf from "nconf";
import WebpackDevServer from "webpack-dev-server";
import { IFluidPackage } from "@fluidframework/container-definitions";
import Axios from "axios";
import { RouteOptions } from "./loader";
import { createManifestResponse } from "./bohemiaIntercept";
import { tinyliciousUrls } from "./multiResolver";

const getThisOrigin = (options: RouteOptions): string => `http://localhost:${options.port}`;

export const before = async (app: express.Application) => {
    app.get("/getclientsidewebparts", async (req, res) => res.send(await createManifestResponse()));
    app.get("/", (req, res) => res.redirect(`/new`));
};

export const after = (app: express.Application, server: WebpackDevServer, baseDir: string, env: RouteOptions) => {
    const options: RouteOptions = { mode: "local", ...env, ...{ port: server.options.port } };
    const config: nconf.Provider = nconf.env("__").file(path.join(baseDir, "config.json"));

    // Check that tinylicious is running when it is selected
    switch (options.mode) {
        case "docker": {
            // Include Docker Check
            break;
        }
        case "tinylicious": {
            Axios.get(tinyliciousUrls.hostUrl).then().catch((err) => {
                throw new Error(`

                You're running the Webpack-Fluid-Loader with Tinylicious.
                Tinylicious isn't running. Start the Fluid Framework Tinylicious server.
                `);
            });
            break;
        }
        default: {
            break;
        }
    }

    if (options.mode === "docker" || options.mode === "r11s" || options.mode === "tinylicious") {
        options.bearerSecret = options.bearerSecret || config.get("fluid:webpack:bearerSecret");
        if (options.mode !== "tinylicious") {
            options.tenantId = options.tenantId || config.get("fluid:webpack:tenantId") || "fluid";
            if (options.mode === "docker") {
                options.tenantSecret = options.tenantSecret
                    || config.get("fluid:webpack:docker:tenantSecret")
                    || "create-new-tenants-if-going-to-production";
            } else {
                options.tenantSecret = options.tenantSecret || config.get("fluid:webpack:tenantSecret");
            }
            if (options.mode === "r11s") {
                options.fluidHost = options.fluidHost || config.get("fluid:webpack:fluidHost");
            }
        }
    }

    options.npm = options.npm || config.get("fluid:webpack:npm");

    console.log(options);

    if (options.mode === "r11s" && !(options.tenantId && options.tenantSecret)) {
        throw new Error("You must provide a tenantId and tenantSecret to connect to a live routerlicious server");
    }

    app.get("/file*", (req, res) => {
        const buffer = fs.readFileSync(req.params[0].substr(1));
        res.end(buffer);
    });

    /**
     * For urls of format - http://localhost:8080/doc/<id>.
     * This is when user is trying to load an existing document. We try to load a Container with `id` as documentId.
     */
    app.get("/doc/:id*", async (req, res) => {
        fluid(req, res, baseDir, options);
    });

    /**
     * For urls of format - http://localhost:8080/<id>.
     * If the `id` is "new" or "manualAttach", the user is trying to create a new document.
     * For other `ids`, we treat this as the user trying to load an existing document. We redirect to
     * http://localhost:8080/doc/<id>.
     */
    app.get("/:id*", async (req, res) => {
        // Ignore favicon.ico urls.
        if (req.url === "/favicon.ico") {
            res.end();
            return;
        }

        const documentId = req.params.id;
        if (documentId !== "new" && documentId !== "manualAttach") {
            // The `id` is not for a new document. We assume the user is trying to load an existing document and
            // redirect them to - http://localhost:8080/doc/<id>.
            const reqUrl = req.url.replace(documentId, `doc/${documentId}`);
            const newUrl = `${getThisOrigin(options)}${reqUrl}`;
            res.redirect(newUrl);
            return;
        }

        fluid(req, res, baseDir, options);
    });
};

const fluid = (req: express.Request, res: express.Response, baseDir: string, options: RouteOptions) => {
    const documentId = req.params.id;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const packageJson = require(path.join(baseDir, "./package.json")) as IFluidPackage;

    const html =
        `<!DOCTYPE html>
<html style="height: 100%;" lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${documentId}</title>
</head>
<body style="margin: 0; height: 100%;">
    <div id="content" style="min-height: 100%;">
    </div>

    <script src="/node_modules/@fluidframework/webpack-fluid-loader/dist/fluid-loader.bundle.js"></script>
    ${packageJson.fluid.browser.umd.files.map((file) => `<script src="/${file}"></script>\n`)}
    <script>
        var pkgJson = ${JSON.stringify(packageJson)};
        var options = ${JSON.stringify(options)};
        var fluidStarted = false;
        FluidLoader.start(
            "${documentId}",
            pkgJson,
            window["${packageJson.fluid.browser.umd.library}"],
            options,
            document.getElementById("content"))
        .then(() => fluidStarted = true)
        .catch((error) => console.error(error));
    </script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    res.end(html);
};
