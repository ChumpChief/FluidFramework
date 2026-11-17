/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

interface Step {
	name?: string;
	uses?: string;
	if?: string;
	with?: { script?: string; [key: string]: unknown };
}

interface Job {
	if: string;
	steps: Step[];
}

const { jobs } = parse(
	readFileSync(
		new URL("../../workflows/pr-bundle-size-comments.yml", import.meta.url),
		"utf8",
	),
) as { jobs: Record<string, Job> };

function script(job: string, name: string): string {
	const source = jobs[job].steps.find((step) => step.name === name)?.with?.script;
	assert.ok(source, `Missing script: ${job}/${name}`);
	return source
		.replaceAll("${{ github.run_id }}", "123")
		.replaceAll("${{ github.run_attempt }}", "2");
}

const scripts = {
	acknowledge: script("acknowledge-build", "Resolve PR for check SHA"),
	neutral: script("delete-sticky-on-neutral", "Resolve PR for check SHA"),
	pr: script("identify-from-pr-build", "Collect affected PRs"),
	base: script("acknowledge-build", "Resolve base commit from the ADO build"),
	baseline: script("identify-from-baseline-build", "Collect affected PRs"),
	pending: script("acknowledge-build", "Render initial comment body"),
	comparison: script("compare", "Render bundle-size comment body"),
};

interface Pr {
	number: number;
	headRefOid: string;
	baseRefName?: string;
}

interface Build {
	id?: number;
	status: string;
	result: string;
	sourceVersion?: string;
	triggerInfo: Record<string, string>;
}

interface Response {
	ok: boolean;
	status?: number;
	statusText?: string;
	json?: () => Promise<unknown>;
}

interface Options {
	// The dynamic boundary is the workflow's untyped github-script API. Fixtures provide
	// only the methods each script uses; unexpected methods fail instead of making requests.
	github?: object;
	fetch?: (url: URL | string) => Promise<Response>;
	nodes?: Pr[];
	data?: object;
	env?: Record<string, string>;
	detailsUrl?: string;
	sha?: string;
}

interface RunResult {
	outputs: Record<string, unknown>;
	files: Record<string, string>;
	logs: string[];
}

// Run the checked-in action scripts, not copies of their implementation. Dependencies
// are injected so the fixtures cannot write files or contact GitHub/ADO.
async function run(
	name: keyof typeof scripts,
	{
		github = {},
		fetch = async () => assert.fail("Unexpected fetch"),
		nodes,
		data = {},
		env = {},
		detailsUrl = "https://dev.azure.com/fluidframework/10f9b53e-c7fd-4538-9fff-13cd088a436c/_build/results?buildId=123",
		sha = "head",
	}: Options = {},
): Promise<RunResult> {
	const outputs: Record<string, unknown> = {};
	const files: Record<string, string> = {};
	const logs: string[] = [];
	const core = {
		info: (value: string) => logs.push(value),
		startGroup() {},
		endGroup() {},
		setOutput: (key: string, value: unknown) => {
			outputs[key] = value;
		},
	};
	const context = {
		repo: { owner: "owner", repo: "repo" },
		payload: { check_run: { head_sha: sha, details_url: detailsUrl } },
	};
	const client =
		nodes !== undefined
			? {
					graphql: async (query: string, variables: { q: string }) => {
						assert.equal(variables.q, `type:pr is:open repo:owner/repo head-sha:${sha}`);
						assert.match(query, /first: 1/);
						return { search: { nodes } };
					},
				}
			: github;
	const fs = {
		readFileSync: (path: string, encoding: string) => {
			assert.equal(path, "bundle-comparison.json");
			assert.equal(encoding, "utf8");
			return JSON.stringify(data);
		},
		writeFileSync: (path: string, body: string) => {
			files[path] = body;
		},
	};
	const fakeRequire = (module: string): typeof fs => {
		assert.equal(module, "fs");
		return fs;
	};
	assert.ok(!scripts[name].includes("${{"), "Unsubstituted action expression");
	const AsyncFunction = (
		Object.getPrototypeOf(async () => {}) as {
			constructor: new (...args: string[]) => (...args: unknown[]) => Promise<void>;
		}
	).constructor;
	await new AsyncFunction(
		"github",
		"context",
		"core",
		"fetch",
		"require",
		"process",
		scripts[name],
	)(client, context, core, fetch, fakeRequire, {
		env: { PR_NUM: "42", HEAD_SHA: "head", BASE_SHA: "base", ...env },
	});
	return { outputs, files, logs };
}

function build(number: number, overrides: Partial<Build> = {}): Build {
	return {
		id: number,
		status: "completed",
		result: "succeeded",
		sourceVersion: `merge${number}`,
		triggerInfo: { "pr.sourceSha": `head${number}`, "pr.number": String(number) },
		...overrides,
	};
}

async function baseline({
	pages = [],
	builds = [],
	parents = {},
	response,
}: {
	pages?: Pr[][];
	builds?: Build[];
	parents?: Record<string, string[] | undefined>;
	response?: Response;
} = {}): Promise<
	RunResult & {
		prs: { number: number; head: string }[];
		cursors: (string | undefined)[];
		mergeQueries: Record<string, string | undefined>[];
		fetches: number;
	}
> {
	const cursors: (string | undefined)[] = [];
	const mergeQueries: Record<string, string | undefined>[] = [];
	let fetches = 0;
	const github = {
		graphql: async (query: string, variables: Record<string, string | undefined>) => {
			if (query.includes("pullRequests(")) {
				cursors.push(variables.cursor);
				const index = cursors.length - 1;
				return {
					repository: {
						pullRequests: {
							nodes: pages[index] ?? [],
							pageInfo: {
								hasNextPage: index + 1 < pages.length,
								endCursor: `page${index + 1}`,
							},
						},
					},
				};
			}
			mergeQueries.push(variables);
			const repository: Record<string, { parents: { nodes: { oid: string }[] } } | undefined> =
				{};
			for (const [alias, sha] of Object.entries(variables)) {
				if (alias.startsWith("commit")) {
					assert.ok(sha);
					repository[alias] =
						Object.hasOwn(parents, sha) && parents[sha] === undefined
							? undefined
							: {
									parents: {
										nodes: (parents[sha] ?? ["baseline", "head"]).map((oid) => ({ oid })),
									},
								};
				}
			}
			return { repository };
		},
	};
	const fetch = async (input: URL | string): Promise<Response> => {
		fetches++;
		const url = new URL(input);
		assert.equal(
			url.origin + url.pathname,
			"https://dev.azure.com/fluidframework/public/_apis/build/builds",
		);
		assert.equal(url.searchParams.get("definitions"), "11");
		assert.equal(url.searchParams.get("maxBuildsPerDefinition"), "500");
		assert.equal(url.searchParams.get("queryOrder"), "queueTimeDescending");
		return response ?? { ok: true, json: async () => ({ value: builds }) };
	};
	const result = await run("baseline", { github, fetch, sha: "baseline" });
	assert.equal(typeof result.outputs.prs, "string");
	return {
		...result,
		prs: JSON.parse(result.outputs.prs as string) as { number: number; head: string }[],
		cursors,
		mergeQueries,
		fetches,
	};
}

describe("PR bundle-size comment workflow", () => {
	it("discovers current heads and excludes stale heads for acknowledgement, deletion, and comparison", async () => {
		const pr = { number: 42, headRefOid: "head", baseRefName: "main" };
		const expected = {
			acknowledge: { pr_num: 42, head_sha: "head" },
			neutral: { pr_num: 42 },
			pr: { prs: JSON.stringify([{ number: 42, head: "head" }]) },
		};
		for (const name of ["acknowledge", "neutral", "pr"] as const) {
			assert.deepEqual((await run(name, { nodes: [pr] })).outputs, expected[name]);
			assert.deepEqual(
				(await run(name, { nodes: [], sha: "old-head" })).outputs,
				name === "pr" ? { prs: "[]" } : {},
			);
		}
	});

	it("resolves the exact ADO build's first merge parent with best-effort failure handling", async () => {
		for (const kind of [
			"success",
			"no-id",
			"no-source",
			"http",
			"network",
			"commit",
			"one-parent",
		]) {
			const fetch = async (url: URL | string): Promise<Response> => {
				assert.notEqual(kind, "no-id");
				assert.equal(
					url,
					"https://dev.azure.com/fluidframework/10f9b53e-c7fd-4538-9fff-13cd088a436c/_apis/build/builds/123?api-version=7.1",
				);
				if (kind === "network") throw new Error("offline");
				return {
					ok: kind !== "http",
					status: 503,
					json: async () => (kind === "no-source" ? {} : { sourceVersion: "merge" }),
				};
			};
			const github = {
				rest: {
					repos: {
						getCommit: async (args: unknown) => {
							assert.deepEqual(args, { owner: "owner", repo: "repo", ref: "merge" });
							if (kind === "commit") throw new Error("unavailable");
							return {
								data: {
									parents:
										kind === "one-parent"
											? [{ sha: "only" }]
											: [{ sha: "target" }, { sha: "head" }],
								},
							};
						},
					},
				},
			};
			const result = await run("base", {
				github,
				fetch,
				detailsUrl:
					kind === "no-id"
						? "https://dev.azure.com/fluidframework/public/_build/results"
						: undefined,
			});
			assert.deepEqual(result.outputs, kind === "success" ? { base_sha: "target" } : {}, kind);
		}
	});

	it("fans out by retained build, PR number, current head, and merge parent across PR pages", async () => {
		const prs = Array.from({ length: 10 }, (_, i) => ({
			number: i + 1,
			headRefOid: `head${i + 1}`,
		}));
		const result = await baseline({
			pages: [prs.slice(0, 5), prs.slice(5)],
			builds: [
				build(1, { result: "partiallySucceeded", sourceVersion: "new-partial" }),
				build(1),
				build(1, { sourceVersion: "older-success" }),
				build(2, { status: "inProgress" }),
				build(2, { result: "partiallySucceeded" }),
				build(3, { result: "failed" }),
				build(4, { id: undefined }),
				build(5, { triggerInfo: { "pr.sourceSha": "old-head", "pr.number": "5" } }),
				build(6, { triggerInfo: { "pr.sourceSha": "head6", "pr.number": "999" } }),
				build(7),
				build(8),
				build(9),
				build(10, { sourceVersion: undefined }),
			],
			parents: {
				merge7: ["other-baseline", "head"],
				merge8: undefined,
				merge9: ["only-parent"],
			},
		});
		assert.deepEqual(result.prs, [
			{ number: 1, head: "head1" },
			{ number: 2, head: "head2" },
		]);
		assert.deepEqual(result.cursors, [undefined, "page1"]);
		assert.equal(result.fetches, 1);
		assert.equal(result.mergeQueries.length, 1);
		assert.deepEqual(
			Object.entries(result.mergeQueries[0])
				.filter(([key]) => key.startsWith("commit"))
				.map(([, sha]) => sha),
			["merge1", "merge2", "merge7", "merge8", "merge9"],
		);
	});

	it("avoids unnecessary baseline lookups and fails visibly on ADO errors", async () => {
		const empty = await baseline();
		assert.deepEqual(empty.prs, []);
		assert.equal(empty.fetches, 0);
		const pages = [[{ number: 1, headRefOid: "head1" }]];
		const unmatched = await baseline({ pages });
		assert.deepEqual(unmatched.prs, []);
		assert.deepEqual(unmatched.mergeQueries, []);
		for (const response of [
			{ ok: false, status: 503, statusText: "Unavailable" },
			{ ok: true, json: async () => ({}) },
		]) {
			await assert.rejects(baseline({ pages, response }), /ADO PR build lookup/);
		}
	});

	it("renders pending with resolved/unresolved base, diagnostic footer, and final newline", async () => {
		for (const base of ["base", ""]) {
			const { files, logs } = await run("pending", { env: { BASE_SHA: base } });
			const body = files["acknowledge.md"];
			assert.deepEqual(Object.keys(files), ["acknowledge.md"]);
			assert.equal(
				body,
				[
					"## Bundle size comparison",
					"",
					`Base commit: ${base ? "`base`" : "_could not be determined; will be reported when the comparison runs_"}`,
					"Head commit: `head`",
					"",
					"Pending — `Build - client packages` is running. Results will appear here when the build completes.",
					"",
					"<!-- pr-bundle-size-comments: run_id=123 attempt=2 -->",
					"",
				].join("\n"),
			);
			assert.equal(logs[1], body);
		}
	});

	it("renders notable additions/removals and inclusive 500-byte deltas above the full inventory", async () => {
		const sizes = (n: number): { parsedSize: number; gzipSize: number } => ({
			parsedSize: n,
			gzipSize: n,
		});
		const data = {
			kind: "completed",
			baseCommit: "base",
			comparison: {
				pkg: {
					added: { compare: sizes(1) },
					removed: { base: sizes(1) },
					up: { base: sizes(1), compare: sizes(501) },
					down: { base: sizes(501), compare: sizes(1) },
					small: { base: sizes(1), compare: sizes(500) },
					unchanged: { base: sizes(1), compare: sizes(1) },
				},
				empty: {},
			},
		};
		const { files, logs } = await run("comparison", { data });
		assert.deepEqual(Object.keys(files), ["bundle-comparison.md"]);
		const body = files["bundle-comparison.md"];
		const [summary, inventory] = body.split("<details>");
		for (const line of ["➕ `added`", "➖ `removed`", "🔴 `up`", "🟢 `down`"]) {
			assert.ok(summary.includes(line));
			assert.ok(inventory.includes(line));
		}
		assert.doesNotMatch(summary, /`small`|`unchanged`/);
		assert.match(inventory, /`small`.*\(\+499\)/);
		assert.match(inventory, /`unchanged`.*\(0\)/);
		assert.match(body, /Base commit: `base`\nHead commit: `head`/);
		assert.ok(body.endsWith("<!-- pr-bundle-size-comments: run_id=123 attempt=2 -->\n"));
		assert.equal(logs[1], body);
	});

	it("distinguishes empty comparisons from comparisons below the notable threshold", async () => {
		for (const comparison of [{}, { pkg: {} }]) {
			const result = await run("comparison", { data: { kind: "completed", comparison } });
			assert.match(result.files["bundle-comparison.md"], /No bundles found in comparison\./);
			assert.doesNotMatch(result.files["bundle-comparison.md"], /<details>/);
		}
		const result = await run("comparison", {
			data: {
				kind: "completed",
				comparison: {
					pkg: {
						small: {
							base: { parsedSize: 1, gzipSize: 1 },
							compare: { parsedSize: 2, gzipSize: 2 },
						},
					},
				},
			},
		});
		assert.match(
			result.files["bundle-comparison.md"],
			/No bundles changed by ≥ 500 bytes parsed\./,
		);
	});

	it("renders expected failures as side-specific messages and unknown kinds with a fallback", async () => {
		for (const side of ["base", "head"]) {
			for (const kind of [
				"no-build",
				"in-progress",
				"all-failed",
				"no-id",
				"no-analyzer-jsons",
				...(side === "base" ? ["no-base-commit"] : []),
			]) {
				const result = await run("comparison", { data: { kind, side } });
				const body = result.files["bundle-comparison.md"];
				assert.match(body, /Base commit: _unresolved_/);
				assert.doesNotMatch(body, /Comparison failed with kind/);
				assert.equal(body.includes("⚠️ Comparison unavailable."), kind !== "in-progress");
				assert.equal(body.includes("Pending —"), kind === "in-progress");
				if (kind === "in-progress")
					assert.ok(body.includes(side === "base" ? "baseline CI build" : "PR's CI build"));
			}
		}
		const result = await run("comparison", { data: { kind: "unknown", side: "other" } });
		assert.match(
			result.files["bundle-comparison.md"],
			/Comparison failed with kind `unknown` on the `other` side/,
		);
	});

	it("filters exact public check names, event actions, and relevant conclusions", () => {
		const project = "10f9b53e-c7fd-4538-9fff-13cd088a436c";
		for (const name of [
			"acknowledge-build",
			"delete-sticky-on-neutral",
			"identify-from-pr-build",
			"identify-from-baseline-build",
		]) {
			const condition = jobs[name].if;
			const check =
				name === "identify-from-baseline-build"
					? "Build - Client bundle size artifacts"
					: "Build - client packages";
			assert.ok(condition.includes(`github.event.check_run.name == '${check}'`));
			assert.ok(
				condition.includes(`contains(github.event.check_run.details_url, '${project}')`),
			);
			const action = name === "acknowledge-build" ? "created" : "completed";
			assert.ok(condition.includes(`github.event.action == '${action}'`));
		}
		assert.ok(
			jobs["delete-sticky-on-neutral"].if.includes(
				"github.event.check_run.conclusion == 'neutral'",
			),
		);
		for (const name of ["identify-from-pr-build", "identify-from-baseline-build"]) {
			assert.ok(
				jobs[name].if.includes(
					"(github.event.check_run.conclusion == 'success' || github.event.check_run.conclusion == 'failure')",
				),
			);
		}
	});

	it("deletes the neutral sticky only when a PR was resolved", () => {
		const sticky = jobs["delete-sticky-on-neutral"].steps.at(-1);
		assert.ok(sticky);
		assert.ok(sticky?.uses?.startsWith("marocchino/sticky-pull-request-comment@"));
		assert.equal(sticky.if, "steps.find_pr.outputs.pr_num != ''");
		assert.deepEqual(sticky.with, {
			header: "bundle-size-report",
			number: "${{ steps.find_pr.outputs.pr_num }}",
			delete: true,
		});
	});
});
