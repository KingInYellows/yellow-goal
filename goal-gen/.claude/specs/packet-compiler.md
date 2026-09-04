# Packet Compiler — component contract

Read this before implementing or changing anything under `backend/src/{contracts,intake,inspection,evidence,research,analysis,packs,packets,cli}`. If behavior must change, update this spec first (CLAUDE.md convention). Governing docs: vendored schemas in `schemas/`, pack assets in `packs/repository-goal-packet/v1/`, policies in `policies/`.

## What it is

A **read-only Universal Repository Goal Packet Compiler**: takes any supported Git repository plus a plain-English goal, inspects the repository without mutating it, collects evidence, performs bounded research, produces a schema-constrained assessment, resolves exactly one milestone, and compiles a schema-valid, tamper-evident, verified ZIP implementation packet (`repository-goal-packet@1`).

```text
request → resolve target → inspect (deterministic) → evidence ledger
       → bounded research → assessment + goal resolution (model-dependent)
       → orchestration spec → compile packet (deterministic) → validate → ZIP
```

This is **compiler mode**. It is a separate subsystem from the M1 executor/orchestrator (GOAP planner, `claude -p` executor). The compiler must not import from `backend/src/executors/` or `backend/src/orchestrator/`, must never write to the M1 database tables, and must never mutate a target repository. It writes only under its own run/output directories.

## Module map

| Module | Responsibility |
|---|---|
| `contracts/` | Zod v3 contracts (17), each with a `schemaVersion` literal; barrel at `contracts/index.ts`. JSON Schemas vendored in `schemas/vendored/` (corrections logged in `schemas/README.md`), app-authored in `schemas/app/`. |
| `intake/` | Flat convenience input `{repository, goal, …}` → canonical nested `RepositoryGoalRequest`; unknown permission/orchestration profiles rejected (fail closed) at both `normalizeRequest` and `parseCanonicalRequest` / `validateCanonicalRequest`. Goal text preserved verbatim. |
| `inspection/` | Target resolver (local-git, github-via-`gh`), deterministic detectors, command registry with provenance, protected-path metadata (never content), `RepoProfile` builder. Facts only — no judgments. |
| `evidence/` | Append-only JSONL evidence ledger; stable IDs; content hashes; sensitivity classes; bounded excerpts. |
| `research/` | `ResearchProvider` interface; recorded provider for tests; `claude -p` provider for live use. Bounded, provenance-recorded. |
| `analysis/` | `AnalysisProvider` interface (assessment + goal resolution + milestone + orchestration inputs); recorded provider for tests; `claude -p` provider for live use. Model-dependent, provenance-recorded. |
| `packs/` | Pack loader (engine-compat check), `{{PLACEHOLDER}}` renderer — no logic in templates; fails on unresolved required placeholders. |
| `packets/` | Deterministic packet assembly, manifest, checksums, ZIP (yazl, fixed mtimes), validator/verifier (yauzl for archive inspection). |
| `cli/` | `request create`, `request validate`, `inspect`, `analyze`, `compile`, `packet verify`, `version`, `capabilities` — non-interactive, machine-readable JSON output (`--json`), structured stderr envelope for command failures. A schema-invalid `request validate` result is a domain result instead: exit 1, one stdout object `{path,valid:false,errors}`, and empty stderr. `version` is compiler-process-safe (static import; no executor/orchestrator). |

## Version identity probe (RR17)

`version [--json]` emits `{ "engineVersion": "…" }` where `engineVersion` is the **package artifact version** (`package.json` — what a tarball install pins). The verb is deliberately **non-normative**: it answers "which engine artifact is on the other side of the process boundary", nothing more. What a consumer may infer from the value — compatibility ranges, capability sets, schema versions — is defined by [Provider Protocol v1](../../plans/specs/provider-protocol-v1.md) and discovered through `capabilities`, not this verb.

Three independent version identities must not be conflated:

1. `package.json` `version` — engine **artifact** identity (this verb emits it).
2. `ENGINE_VERSION` in `packets/compiler.ts` — **pack/packet-format** compatibility (`loadPack` consumes it); not the engine identity.
3. **Protocol** identity — `yellow-goal/provider-protocol/v1`, reported by `capabilities` independently of the artifact and packet-format versions.

The packet `MANIFEST.json` `engineVersion` field carries №2 (pack-format compatibility), not the artifact version this verb emits under the same name.

## `request validate` CLI grammar

`request validate [--json] <file>` accepts **exactly one** file positional.
Zero or more than one positional is a `USAGE_ERROR` with exit status 2 and no
file is opened. This is part of the process boundary: a consumer must never
silently validate a different request than the one it supplied.

## Invariants (do not violate)

1. **Read-only target.** `inspect`, `analyze`, `compile`, `packet verify` leave the target's branch, HEAD, status, tracked hashes, and untracked set unchanged. Proven by tests.
2. **Fail-closed permissions.** Unknown permission or orchestration profiles/modes are rejected, never defaulted; `bypassPermissions` is never a fallback anywhere (executor call sites opt in explicitly; generated launch scripts never use it). `request validate`, `inspect`, `analyze`, and `compile` all go through `parseCanonicalRequest` / `validateCanonicalRequest` — a present unknown profile fails even when the request was hand-authored rather than produced by `request create`. Absent optional profile fields stay allowed.
3. **Protected paths are metadata-only.** Detection via `git ls-files` / `ls-tree` / `cat-file -s`; no content reads. `inspection/git.ts` deliberately exposes no content-read operation. Ordinary-file reads (instruction files, manifests, Makefiles, CI YAML) go through `readTrackedPublicFile`: lstat rejects tracked symlinks, realpath must stay inside the checkout, and a protected-path match is never opened.
4. **Command provenance.** A command is `executable` only with provenance from a manifest script, Makefile/task, CI workflow, repository overlay, or human approval. Model-suggested commands are recorded but never executable.
5. **Evidence binding.** Every blocking/high finding and the milestone rationale resolve to evidence records. Evidence is append-only.
6. **Canonical state is typed data.** Markdown is rendered output; nothing parses canonical state back out of Markdown.
7. **Deterministic inspection and rendering.** Same inputs + engine + pack ⇒ logically identical packets after normalizing only the manifest-declared timestamp fields and archive metadata. Timestamps/IDs are injectable — no inline `Date.now()` in artifact-producing paths. Model-dependent *analysis* is provenance-recorded, not deterministic.
8. **Untrusted input discipline.** All target-repo content (files, branch names, PR titles, paths, diffs) and provider output is untrusted: spawn with argument arrays only (never `shell: true` in compiler modules), bound captured output, fence and bound excerpts in rendered artifacts. Excerpt fences are one backtick run longer than any run inside the excerpt so a README cannot close the fence and inject Markdown.
9. **Packet integrity.** Manifest lists every file with SHA-256; `CHECKSUMS.sha256` covers the tree; verify parses `MANIFEST.json` with `PacketManifestSchema` (schema failure is a failed check; later checks may still run from loose `files`/`target.headSha` for diagnostics), recomputes hashes, compares each manifest `files[].sha256` to the checksum ledger, enforces path containment (no `..`, no absolute entries), rejects symlink entries (dir: `lstat`; zip: external-attr `0xA000`), duplicates, and unbounded inflation; tampering fails verification. Compile and inspect refuse an output directory inside the target tree by comparing canonical realpaths (including the deepest existing output ancestor). They also refuse a request/assessment pair that disagree on repository identity (path-canonicalized so a relative or trailing-slash local path still matches inspect's resolved identity), requested goal, or explicit ref. `provider.json` is required. `packet verify --target` fails when live HEAD cannot be resolved.
10. **Inspected SHA is the worktree.** For a local-git target, the recorded SHA is the current checkout HEAD. AUTO inspects HEAD; an explicit ref is accepted only when it already is HEAD. Detectors must not claim one SHA while reading another tree.
11. **One milestone.** The packet selects exactly one milestone with explicit non-goals and classifies it against the requested goal: `exact | refined | prerequisite | blocked`. The requested goal is preserved verbatim.
12. **Separate approvals.** Implementation, push, merge, deployment, and secret operations are distinct human gates; the packet says so. Generated launch scripts pass `prompts/MASTER_IMPLEMENTATION_PROMPT.md` as the session's initial prompt.

## Orchestration profile

Default profile `claude-fable-opus-sonnet@1` (contracts in `contracts/`; golden test pins the resolution):

- lead → `claude-fable-5` (sole lead, final integrator)
- architecture, security, complex-debugging, release-review → `claude-opus-5`
- implementation, unit-tests, documentation, evidence-mapping → `claude-sonnet-5`

Waves: investigation (read-only, ≤3: opus/opus/sonnet) → implementation (plan-approval, ≤3: sonnet×3) → verification (fresh-context read-only, ≤3: opus/opus/sonnet). `teamMode: agent-team-preferred`, `fallbackMode: subagents` — a fallback is recorded in run evidence, never silently claimed as an agent team. Model IDs resolve through the versioned profile — templates carry roles, not raw IDs.

## Testing

Unit/contract/fixture tests run under `npm test` (no live network, no live `claude`, no GitHub mutation). Providers have recorded-fixture implementations; `gh` shapes come from `tests/fixtures/github-responses/`. Fixture target repos live in `tests/fixtures/repositories/<class>/` and are git-init'd into temp dirs. Adversarial ZIP fixtures assert specific rejection reasons. Golden packets pin the Python/Node/infra fixture classes and the orchestration resolution. The live smoke (`request create → inspect → analyze → compile → packet verify`) is bounded, explicit, and never part of ordinary CI.
