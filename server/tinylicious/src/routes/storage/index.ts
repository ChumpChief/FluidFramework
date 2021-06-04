/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { Router } from "express";
import * as blobs from "./git/blobs";
import * as commits from "./git/commits";
import * as refs from "./git/refs";
import * as tags from "./git/tags";
import * as trees from "./git/trees";
import * as repositoryCommits from "./repository/commits";
import * as contents from "./repository/contents";
import * as headers from "./repository/headers";

export interface IRoutes {
    git: {
        blobs: Router;
        commits: Router;
        refs: Router;
        tags: Router;
        trees: Router;
    };
    repository: {
        commits: Router;
        contents: Router;
        headers: Router;
    };
}

export function create(): Router {
    const apiRoutes = {
        git: {
            blobs: blobs.create(),
            commits: commits.create(),
            refs: refs.create(),
            tags: tags.create(),
            trees: trees.create(),
        },
        repository: {
            commits: repositoryCommits.create(),
            contents: contents.create(),
            headers: headers.create(),
        },
    };

    const router: Router = Router();
    router.use(apiRoutes.git.blobs);
    router.use(apiRoutes.git.refs);
    router.use(apiRoutes.git.tags);
    router.use(apiRoutes.git.trees);
    router.use(apiRoutes.git.commits);
    router.use(apiRoutes.repository.commits);
    router.use(apiRoutes.repository.contents);
    router.use(apiRoutes.repository.headers);

    return router;
}
