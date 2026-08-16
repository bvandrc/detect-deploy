## Project

`detect-deploy` — a GitHub Action that polls a URL until its content changes, to detect when a deploy has gone live.

- **Layout**: `action.yml` declares the inputs and points at `dist/index.js`; `src/index.ts` is the source; `test/` holds `*.test.mts` node:test files.
- **Build output is committed**: esbuild bundles `src/index.ts` into `dist/index.js`, and Actions runs that bundle — run `npm run build` and commit `dist/` with any `src/` change, or the action ships stale code.
- **Private package**: not published to npm; consumed as an action by ref.

## Code conventions

Conventions live outside this file, synced from https://github.com/bvandrc/bvandrc-conventions — follow all of them:

@conventions/typescript.md — language-level TypeScript/JavaScript rules
@conventions/all.md — practice for every repo: branches, formatting, markdown, PR reviews

## Commands

- `npm run build` — esbuild bundle to `dist/index.js`.
- `npm run format` — Biome check/fix. `npm run check` — the full gate: Biome plus `npm run ts:check` (`tsc --noEmit`); it's what CI runs.
- `npm test` — `node --test` over `test/*.test.mts`.

## Repo conventions

- **Package manager**: npm (`package-lock.json`).
- **Convention files**: `conventions/` is synced from https://github.com/bvandrc/bvandrc-conventions by `.github/workflows/sync-conventions.yml` and overwritten on every sync. Edit a rule upstream, never in that directory.
