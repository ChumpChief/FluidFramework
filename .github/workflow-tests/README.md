# Workflow and pipeline tests

This standalone TypeScript suite tests repository CI definitions.
It uses Node's test runner and has its own dependencies, independent of the product and build-tools workspaces.

From this directory, run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Node and pnpm engine requirements and the `packageManager` pin match the root `package.json`.
CI selects Node from the root `.nvmrc` and pnpm from the root `package.json`.
The standalone workspace uses the repository's public package feed and install settings.
To update dependencies and the lockfile, run `pnpm install-no-frozen`.

Tests live in `src/*.test.ts`.
`pnpm build` compiles them into `lib/`; `pnpm test` runs the compiled tests.
Paths to repository files are resolved relative to the test module, so execution does not depend on the caller's working directory.
Add tests for other workflows or pipelines alongside the existing test file.

The bundle-size tests parse the actual workflow and execute its inline JavaScript with injected API and filesystem fixtures.
They characterize script behavior and selected workflow wiring; they do not simulate GitHub's scheduler or perform live GitHub/ADO operations.

The **Workflow tests** GitHub Actions check runs on pull requests and pushes to `main` when workflow definitions, pipeline definitions, workflow scripts, this suite, or its shared runtime/install configuration change.
Keep its path filters aligned with any additional configuration paths read by tests.
