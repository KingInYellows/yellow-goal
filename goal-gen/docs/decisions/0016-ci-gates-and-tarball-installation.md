# 0016 — CI gates in GitHub Actions; installation via npm tarball with a tsx bin shim

- Status: accepted
- Date: 2026-08-26

## Context

The repository had no CI at all: typecheck, the deterministic test suite, the eval gate, and the
contract-compatibility tests (`tests/contracts/compat.test.ts`) only ran when someone remembered
to run them. Two gaps compounded this:

1. **Migrations were untested.** `tests/db/` provisions PGlite through drizzle-kit `pushSchema`,
   which never reads the journal-driven SQL files under `backend/src/db/migrations/` — the exact
   artifacts `drizzle-kit migrate` applies in production (R35). A broken or missing migration
   would only surface on a live deploy.
2. **There was no installation story.** `goal-gen` is `"private": true` with no `bin` and no
   packlist; an external process consumer (the yellow-plugins external-engine bridge) had no way
   to obtain and spawn the engine except `npm run cli --` from a full repo checkout with
   devDependencies installed. `zod` — imported throughout `backend/src` — was in
   `devDependencies`, so even a hand-rolled pack would have failed at runtime.

Constraints on packaging: the source ships extensionless ESM imports under
`moduleResolution: Bundler` with `noEmit: true`. Node's native type stripping requires explicit
file extensions, and a tsc-emit build would force extension rewrites across every import — a
repo-wide migration this decision does not want to couple to.

## Decision

1. **`.github/workflows/ci.yml`** (repo root — the project lives in the `goal-gen/`
   subdirectory, so every step sets `working-directory: goal-gen`). Job `engine`: `npm ci`,
   `npm run typecheck`, `npm test`, `npm run eval` on Node 22.22.x. Job `install-smoke`:
   `scripts/install-smoke.sh`.
2. **Migration gate** — `tests/db/migrations.test.ts` applies the real SQL migrations through
   `drizzle-orm/pglite/migrator` against embedded PGlite and asserts: every journal entry
   applied, expected tables and enum labels present, idempotent re-run, and structural equality
   (columns / enums / constraints from the Postgres catalogs) with a `pushSchema`-provisioned
   instance, so schema.ts edits without `drizzle-kit generate` fail CI. drizzle-kit's own
   diff is deliberately not used as the oracle — it reports false drift (numeric default
   `0` vs `'0'`) when comparing snapshots against live introspection.
3. **Installation = npm tarball, not a registry.** The package stays `"private": true`
   (blocks accidental `npm publish`; `npm pack` and tarball installs are unaffected). Added:
   a `files` packlist (`bin/`, `backend/src/`, `packs/`, `policies/`, `schemas/` — all runtime
   assets resolve module-relative, so the tarball preserves the checkout layout), a
   `bin/goal-gen.mjs` shim that loads the TypeScript CLI via `tsx`'s ESM API and calls its
   exported `main()`, `tsx` and `zod` moved to runtime `dependencies`, and `engines.node >=22`.
4. **Install-smoke gate** — `scripts/install-smoke.sh` packs the tarball, installs it into a
   scratch consumer directory (mktemp; runtime deps only), and drives the installed bin against
   a scratch git repository: `request create` and `request validate` must emit parseable JSON
   and exit 0, an unknown command must emit the single-line structured stderr envelope and exit
   2, and the target repository must stay clean (`git status --porcelain` empty).
5. **Probe safety preserved.** CI runs vitest with the existing `tests/**/*.test.ts` include;
   live-resource tests keep the `*.probe.ts` suffix (`tests/integration/runner.probe.ts` spawns
   a real `claude`) and must never be pulled into that glob.

## Consequences

- Every PR now enforces typecheck, the deterministic suite, evals, contract compatibility,
  migration application, and the tarball install story.
- Consumers get a supported process contract: install the tarball, spawn `goal-gen`, parse JSON
  stdout / structured stderr, discriminate on exit codes — no checkout, no npm scripts.
- `tsx` becomes a runtime dependency. If the engine later gains a real build step (tsc emit or
  a bundler), the shim can switch to compiled output without changing the bin's contract;
  supersede this ADR when that happens.
- Version pinning for consumers (yellow-plugins bridge) can target the tarball version once the
  provider protocol lands (six-step plan, steps 3–5).
