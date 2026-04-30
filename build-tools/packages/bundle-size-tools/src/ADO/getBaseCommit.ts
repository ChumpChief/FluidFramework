/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { execSync } from "child_process";

/**
 * Gets the commit on the target branch that the current branch is based on.
 *
 * Runs `git merge-base origin/<targetBranch> HEAD` synchronously. The caller is
 * responsible for ensuring the target branch is fetched.
 *
 * @param targetBranch - The name of the target branch (e.g., "main").
 */
export function getBaseCommit(targetBranch: string): string {
	return execSync(`git merge-base origin/${targetBranch} HEAD`).toString().trim();
}
