/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import * as http from "http";
import { AddressInfo } from "net";
import * as util from "util";
import { IHttpServer } from "../server-services-core";

export type RequestListener = (request: http.IncomingMessage, response: http.ServerResponse) => void;

export class HttpServer implements IHttpServer {
    constructor(private readonly server: http.Server) {
    }

    public async close(): Promise<void> {
        await util.promisify(((callback) => this.server.close(callback)) as any)();
    }

    public listen(port: any) {
        this.server.listen(port);
    }

    public on(event: string, listener: (...args: any[]) => void) {
        this.server.on(event, listener);
    }

    public address(): AddressInfo {
        return this.server.address() as AddressInfo;
    }
}
