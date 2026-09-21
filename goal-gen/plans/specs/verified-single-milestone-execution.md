# Verified single-milestone execution — Yellow Harness outcome

Status: proposed design; documentation slice complete (#34, merged on `36eeeae`).
Date: 2026-09-19. Owner: Yellow Goal (Yellow Harness coordination).
Decision: [ADR-0018](../../docs/decisions/0018-verified-single-milestone-execution.md).
Engine bases: documentation parent `09bcd16cd25ec249e3248d3ce7dcb4536a0d348e` (#34);
current `main` `5685f5e55d19a4b50fd84e30a1720bcb15293f89` (#24 on #40 squash `62c860e`).

## Phasing

Four layers — do not conflate them:

| Layer | What it is | Status |
|---|---|---|
| 1. Eventual product outcome | One approved milestone, one repo, one immutable **base** revision, one bounded implementation worker → independently verified patch (against a recorded **candidate** commit or tree snapshot) or evidence-backed blocker. No automatic merge or deployment. | Named; not executable yet |
| 2. Documentation increment | PRD FR-14–FR-17, proposed ADR-0018, this spec (VS-01–VS-07). | **Complete** (#34) |
| 3. First code increment | Fixture-only acceptance-evidence recording through an existing engine process seam; disposable git fixture; deterministic local checks only. | **Implemented** (yellow-goal #36). Git-free JSON recorder only. |
| 3b. Observed fixture verification | Engine-owned fixed profiles, disposable-repo observer, packed `acceptance record` subprocess, separate fixture-scoped decision. | **Implemented** (yellow-goal #37). Not live target-bound execution. |
| 3c. Candidate-bound offline milestone | Additive FILE-CONTENT candidate path, durable bundle, installed fresh-process replay of trusted checks. | **Implemented** (yellow-goal #39). Not verified single-milestone execution completed. Not live execution. |
| 3d. Committed-source capture | Additive Git **object-read** capture of a pinned commit plus one engine-owned package-manifest/lockfile coherence profile. CI uses owned git fixtures; real yellow-goal capture is demonstration evidence, not a CI pin of live `main`. | **Implemented** (yellow-goal #40). Not verified single-milestone execution completed. Not live execution. |
| 3e. Captured-base candidate replay | Persist selected captured bytes; `acceptance reproduce` dispatches by `COMPLETE` schema; FILE-CONTENT overlay onto the captured base in an owned snapshot. | This increment. Not verified single-milestone execution completed. Not live execution. |
| 4. Still deferred | Live target-bound execution; Protocol v1 real-run capabilities; promoting scratch/`bypassPermissions`; yellow-plugins host/provider integration. Protocol v1 stays stub-only today (ADR-0017). | Deferred |

## Outcome (layer 1)

Given one explicitly approved milestone, one named repository, and one immutable **base**
revision, Yellow Harness eventually dispatches **one** bounded implementation worker and
returns either:

1. a reviewable patch on that base, plus independently checked acceptance evidence against
   the **candidate** commit or tree snapshot, or
2. an evidence-backed blocker.

No automatic merge, publication, or deployment.

A PR-readiness report alone is not this outcome. Cursor plugin parity is not a
prerequisite.

## Ownership

- **yellow-goal** owns canonical acceptance and evidence semantics (this spec, FR-14–FR-17,
  engine-emitted evidence records).
- **yellow-plugins** owns host/provider integration (stack routes, Cursor/Claude wiring).
- A read-only **review** role (e.g. `readonly: true` on a host reviewer) is separate from
  the **verification** process, which may write disposable test artifacts. Independent
  verification is not defined by host `readonly` flags alone.

## Requirements

| ID | Requirement |
|---|---|
| VS-01 | One owner repository per milestone; plugins work is a separate milestone, never a dual-root write. |
| VS-02 | **Base** revision is recorded before the writer starts; the writer does not retarget main silently. |
| VS-03 | Coordinator is not the source writer. Reviewers may be read-only; that is a host integration choice, not the definition of independent verification. |
| VS-04 | A **non-empty required-check set** (`requiredChecks`: at least one `{id, command, cwd}` tuple in the same fixture JSON) is declared up front; the recorded `checks[]` must exactly match it — no missing, duplicate, or unexpected ids, each result row's `command`/`cwd` equal to the declared tuple for that id — and an empty `requiredChecks` is itself malformed evidence, never a vacuous `passed` (see the outcome table below). Each check is recorded as passed / failed / blocked / not-run with command, cwd, a discriminated **candidate** identity (distinct from base; see below), the working-tree content measured immediately before and after the check ran (`preCheckTree`/`postCheckTree`), and an **observed** `exitStatus` when the check exited normally. `status` is derived from that check's own observed outcome, never asserted independently: `passed` requires a normal exit with `exitStatus: 0` **and** leftover endpoint `postCheckTree` equal to `preCheckTree` (this increment's mutation detector is leftover Git tree identity plus the submodule, empty-directory, and embedded-repository post-check re-verifies, not proof working content was unchanged *during* the check; see the recheck-rule bound); any other normal exit with no detected leftover mutation is `failed`. Never-launched checks are `not-run` — **omit** `exitStatus` and **require** `reason` — and `not-run` is reserved for checks that never started. Launched checks killed by timeout/signal with no Node exit code are `blocked` (**never** `not-run`, **never** `passed`): **omit** or null `exitStatus`, **require** `signal` or `reason`. A check whose leftover `postCheckTree` differs from `preCheckTree`, or that leaves a submodule dirty, an extra check-visible path inside a registered submodule, an empty directory, or a nested `.git` that is not a registered submodule after the check, is leftover mutation this detector can see — whether it ran in the shared tree or an isolated snapshot — and is `blocked` with `reason: "candidate mutated by check"`; crediting the resulting content requires a separate, independently rerun check row, never a relabel of the mutating check's own exit. See the recheck rule and outcome table below. |
| VS-05 | Independent **verification** (the acceptance decider) consumes VS-04 evidence plus the diff against the candidate content identified by `candidateIdentity`. Worker narrative cannot succeed the milestone. A traceable CI record (discriminated candidate identity, job/command, result) may count as verification input when it identifies the checked candidate; a bare badge or chat claim does not. A successfully recorded VS-04 evidence record is not itself acceptance — the decider still applies before a candidate is accepted (see roles, below). |
| VS-06 | Blockers include: missing evidence, checks not-run, stack-provider unresolved when mutation is required, overlapping unreviewed file conflict, attempt to use live `claude-code` / `npm run runner` / protocol real execution in an increment that has not authorized them. |
| VS-07 | Compiler isolation and process-pin consumption are unchanged. No cross-repo TS import. |

## Non-goals (layer 4 and this document)

For the **documentation increment** and **Protocol v1 today**: live target-bound execution;
Protocol v1 capability adds; HTTP/SSE; persistence/control-plane; merge queue; subscriptions;
CE config; publishing `goal-gen` or plugins; copying generated Cursor plugins into
`~/.cursor/plugins/local`; promoting scratch/`bypassPermissions`.

These non-goals do **not** permanently exclude a bounded implementation worker from the
**eventual product outcome** (layer 1).

## Documentation increment (complete, #34)

**Owner:** yellow-goal. **Status:** merged.

Landed:

1. PRD amendment (FR-14–FR-17 + §12 phasing note)
2. ADR-0018 (`proposed`)
3. this spec under `goal-gen/plans/specs/`

No `backend/`, protocol, pin.ts, yellow-plugins, `.cursor/`, or `.compound-engineering/`
changes were in scope.

## Later code slice (layer 3 — not authorized, not a second spec)

Fixture-only acceptance-evidence recording against a disposable git fixture, never the
sibling plugins clone. Deterministic local checks only. No protocol `capabilities` change.
No live provider.

### Roles: observer, recorder, decider

Three distinct roles, deliberately not collapsed into one:

- **Observer** — whatever actually runs each required check and measures
  `preCheckTree`/`postCheckTree` around it: a fixed, deterministic local-check script
  against the disposable git fixture, a CI job, or a human running commands by hand. The
  observer is **out of scope for this contract**. This spec does not define, authorize, or
  implement a general-purpose command runner — the first code increment's checks are a
  small, fixed set against a disposable fixture it owns, not a mechanism for executing
  arbitrary caller-supplied commands. The observer is also responsible for keeping the real
  git index clean throughout every check's execution (the real-index precondition, see
  Candidate identity below), for choosing `tree` kind whenever extra check-visible
  (untracked or gitignored) paths exist (the commit-kind extra-paths precondition below),
  for rejecting empty directories before any identity is measured and re-verifying
  none remain after every launched check (the empty-directory precondition below),
  for rejecting embedded git repositories before any identity is measured and
  re-verifying none remain after every launched check (the embedded-repository
  precondition below), for applying the submodule precondition
  at both points (dirty working tree/index **or** extra check-visible paths inside
  a registered submodule — not a recursive identity; see below), and for rejecting
  escaping or out-of-tree symlink targets before any identity is measured (the
  escaping-symlink precondition below) — this contract constrains those preconditions
  rather than adding a second identity or a recorder-verified field for any of them.
- **Recorder** — the proposed `acceptance record <fixture.json>` CLI verb below. It
  consumes the observer's already-collected fixture and validates it against this contract
  (schema, required-check-set match including `{id, command, cwd}` tuple equality,
  candidate binding, mutation detection from the supplied
  `preCheckTree`/`postCheckTree` pairs), computes the aggregate `status`, and
  writes the acceptance-evidence record. **The recorder does not execute any check
  itself.** It cannot independently confirm that the fixture's reported exit codes,
  signals, or tree measurements reflect what actually happened on whatever ran them — it
  can only certify that the supplied fixture is internally consistent with this contract.
  An internally consistent fixture is not proof a check was ever really run; trusting the
  record still means trusting the observer. The recorder also has **no git dependency**: it
  takes a single fixture-file argument, never a repository or worktree argument, and never
  invokes `git` itself — no `git rev-parse`, no resolving paths against its own invocation
  CWD or any other repository. Every identity and tree value it compares —
  `candidateIdentity`, `candidateTree`, `preCheckTree`, `postCheckTree` — is a field the
  observer already resolved and wrote into the fixture; the recorder's candidate-binding
  and mutation checks (below) are pure JSON-field comparisons, including that each
  `checks[]` row's `command`/`cwd` equal the `requiredChecks` tuple for that `id`. The
  recorder does not consult a second approved-check manifest and does not run commands.
- **Decider** — the independent verification process (VS-05/FR-16): reviews the recorded
  evidence plus the diff and decides whether the candidate is accepted or blocked. A
  successful recording (recorder exit 0) is necessary evidence for that decision, never the
  decision itself.

### Proposed process interface (contract only — implement in a later PR)

Add a new **non-protocol** dispatcher verb in `backend/src/cli/index.ts`:
`acceptance record <fixture.json>` (name TBD at implementation). This is **not** the `run`
verb and must not be advertised in Provider Protocol v1 `capabilities`.

**Implementation note:** the dispatcher **dynamically imports a new CLI module** (e.g.
`acceptance-record-command.ts`) at invocation time — **not** `run-command` and not
executor/orchestrator code. The compiler/capabilities cold path (`version`, `packet verify`,
`capabilities --json`, etc.) must not load acceptance-recording modules until this verb is
explicitly invoked. Unlike `run`, this verb has no git-spawn dependency to isolate in the
first place — per the Roles section above, the recorder never shells out to `git`.

| Property | Contract |
|---|---|
| stdout | One JSON object on successful **recording** (not run-event JSONL); empty on recorder I/O or usage failure |
| stderr | Single-line structured `{"error":{"code","message"}}` on recorder failure only; empty when recording succeeds (even if checks failed) |
| schema identity | New identity (e.g. `yellow-goal/acceptance-evidence/v1`) — **not** `yellow-goal/evidence/v1` (packet-compiler inspection ledger) |
| Provider Protocol v1 | No new capability; not advertised in `capabilities --json` |

**Recorder exit codes** (a successfully written record is a successful command; the
domain outcome — whether the checked candidate is accepted — lives in the record body and
in the *decider's* separate acceptance decision, never in the recorder's exit code):

| Exit | Meaning |
|---|---|
| 0 | A record was written. This covers **every** required-check outcome — `passed`, `failed`, `blocked`, `not-run` alike. A failing or blocked check is still a successfully recorded result, not a recorder failure. |
| 1 | No record was written: malformed evidence, a required-check-set violation, a candidate-identity violation, or a recorder I/O fault. Structured stderr carries `UNEXPECTED_ERROR` or a specific domain code (see the outcome table below). |
| 2 | Usage / argv error (`USAGE_ERROR`). |

This does not extend the schema-invalid `request validate` exception in
[`goal-gen/AGENTS.md`](../../AGENTS.md); that remains the sole documented
domain-result-as-nonzero-exit case, and the recorder introduces no second one — a
`failed`/`blocked`/`not-run` check is exit 0 (a successful recording of valid negative
evidence), and every exit-1 case is a fault in the fixture or the recorder, never a valid
negative check result.

**Candidate identity** (discriminated — do not use a bare SHA without `kind`):

| `kind` | `value` | When to use |
|---|---|---|
| `commit` | Git commit object name (40-hex SHA-1 or 64-hex SHA-256) | Candidate is a committed revision **and** the checkout has no extra check-visible (untracked or gitignored) paths — only then can `<value>^{tree}` equal a `--force`-complete `preCheckTree` (see the extra-paths precondition below) |
| `tree` | Git tree object name (40-hex SHA-1 or 64-hex SHA-256) | Candidate is an uncommitted working tree snapshot, **or** a checkout with extra check-visible (untracked or gitignored) paths the committed tree cannot contain; compute it via a **temporary index and an isolated object database** — e.g. `GIT_INDEX_FILE=$(mktemp -u)` plus `GIT_OBJECT_DIRECTORY=$(mktemp -d)` (with `GIT_ALTERNATE_OBJECT_DIRECTORIES` set to the **absolute** pathname of the common object store for reads) — `git add -A --force` staging every check-visible path Git's index can hold (including untracked **and otherwise-`.gitignore`d** files and symlinks; empty directories are rejected, not staged — see the empty-directory precondition below) into that scratch index and scratch object store, then `git write-tree` against it **only if `git add` succeeded** (a staging failure **must** abort before `write-tree`; see Isolated object database), then discard both scratch locations — **never** write into the repository's real index or real object database to compute this identity |

The fixture also supplies `candidateTree`: the resolved tree object name for
`candidateIdentity`, computed by the **observer** — identical to `candidateIdentity.value`
for a `tree` kind, or the observer-resolved `<candidateIdentity.value>^{tree}` for a
`commit` kind. For a `commit` kind that value is the committed tree only; it equals a
`--force`-complete `preCheckTree` only when extra check-visible paths are absent (see
the extra-paths precondition below).

**Object-name length.** Every Git object name in this contract —
`candidateIdentity.value`, `candidateTree`, `preCheckTree`, `postCheckTree`,
`baseRevision` — is an opaque lowercase hex string of a Git-supported length: **40**
(SHA-1) or **64** (SHA-256). The length is the repository's object format
(`git rev-parse --show-object-format`); this spec does **not** add a second hasher.
The recorder never hashes and never consults object format; it compares the supplied
strings. **Retraction:** an earlier revision required 40 characters only, which would
reject a valid SHA-256 `write-tree` / commit name. A fixture that mixes 40-hex and
64-hex names, or uses any other length, is malformed evidence.

The recorder treats `candidateTree` as an opaque hex string of that length to compare against `preCheckTree`/`postCheckTree`; per the Roles section
above, it never resolves `^{tree}` itself, takes no repository or worktree argument, and
does not run `git rev-parse` (or any other git command) against its own invocation CWD
or any other repository. Every tree value the recorder compares — `candidateTree`,
`preCheckTree`, `postCheckTree` — is a field the observer already resolved and wrote into
the fixture; this is not a command runner, and the recorder introduces none.

Tree identity computation — `candidateIdentity`, and the `preCheckTree`/`postCheckTree`
measurements below — **must** use a temporary index (`GIT_INDEX_FILE` pointed at a
not-yet-existing path) or an equivalent mechanism that never writes to `.git/index`, and
**must not** leave the repository's real index staged, whether by using the temporary
index throughout or by snapshotting the real index first and exactly restoring it
immediately after.

The temporary path itself **must not already exist** when Git first writes to it: use
`$(mktemp -u)` (reserves a name without creating the file), not plain `$(mktemp)` (creates
a real, existing, zero-byte file). Git treats an existing-but-empty index file as corrupt
— `fatal: ... index file smaller than expected`, exit 128, reproduced directly against Git
2.43 — whereas a genuinely nonexistent path lets Git create a fresh, valid index there.
`mktemp -u`'s create/use gap is a known race in a general-purpose script; it is an
accepted, bounded trade-off here because the fixture-only increment's disposable fixture is
single-process and non-adversarial, not a concurrent or untrusted environment. Remove the
scratch file once the tree object has been computed.

**Isolated object database.** A temporary index keeps `.git/index` untouched, but `git
add`/`git write-tree` still write the blob and tree objects they create into the
repository's **object database** (`.git/objects`) — the temporary index only isolates the
index file; both commands share the real object store regardless of which index they're
pointed at. Force-staging every check-visible path Git's index can hold (`--force`, required above so
`.gitignore`d-but-check-visible files are covered; empty directories are rejected, not
staged) therefore writes whatever those paths
contain — including gitignored credentials, local config, and caches — as recoverable
loose objects into the real, persistent object database. This is not hypothetical for this
repo: `goal-gen/.gitignore` gitignores `.env`/`.env.*` specifically because secrets are
env-only and real values are never committed (`goal-gen/CLAUDE.md`), and the tree-identity
recipe above, run unmodified against a disposable fixture derived from this repo, would
force-stage and permanently write any local `.env` into `.git/objects`.

Tree identity computation **must** therefore also isolate the object database, not only
the index: point `GIT_OBJECT_DIRECTORY` at a fresh, empty scratch directory for the
`add`/`write-tree` pair, and set `GIT_ALTERNATE_OBJECT_DIRECTORIES` to the **absolute**
pathname of the repository's **common** object store —
`git rev-parse --path-format=absolute --git-path objects` (equivalently, `realpath` of
`$(git rev-parse --git-common-dir)/objects`) — so reads of already-committed content —
resolving `baseRevision`, or the base of a `commit`-kind candidate — still succeed. Do
**not** export `$(git rev-parse --absolute-git-dir)/objects`: in a linked worktree
(`goal-gen/AGENTS.md` requires one git worktree per agent run), `--absolute-git-dir` is
the per-worktree admin dir (`.git/worktrees/<name>`), which has no `objects/` —
`git cat-file` then exits 128. Do **not** export the relative path
`git rev-parse --git-path objects` returns without `--path-format=absolute`: from a
subdirectory (this spec's own record-shape example uses `cwd: "goal-gen"`), that value is
`../.git/objects`, and Git 2.43 rejects a `..` component in
`GIT_ALTERNATE_OBJECT_DIRECTORIES` (`unable to normalize alternate object path`). Against
an empty scratch `GIT_OBJECT_DIRECTORY`, either mistake is a hard failure — `git cat-file`
exit 128 — so the alternate cannot do the one thing it is set for. Discard the scratch
object directory once the tree SHA has been read; nothing in it may persist or leave the
process:

```
(
  set -e
  GIT_OBJECT_DIRECTORY=$(mktemp -d)
  GIT_ALTERNATE_OBJECT_DIRECTORIES="$(git rev-parse --path-format=absolute --git-path objects)"
  GIT_INDEX_FILE=$(mktemp -u)
  export GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE
  trap 'rm -rf "$GIT_OBJECT_DIRECTORY"; rm -f "$GIT_INDEX_FILE"' EXIT
  git add -A --force
  git write-tree
)
```

**Staging failure aborts the measurement.** Sequential `git add` / `write-tree` / `rm`
with no `&&`, no `set -e`, and no `trap` continues to `write-tree` after a failed
`git add`. A required clean filter that rejects a path makes `git add -A --force`
exit 128; Git 2.43 then `write-tree`s a fresh empty scratch index as empty-tree
`4b825dc642cb6eb9a060e54bf8d69288fbee4904`, and a trailing successful `rm` makes
the subshell exit 0. Candidate, pre, and post can all collapse to that incomplete
tree and permit a passing record. The example therefore enables `set -e` and puts
cleanup in an `EXIT` `trap`: a failed `git add` **must** abort before `write-tree`,
the scratch paths are still removed, and the subshell exits non-zero. Chaining
`git add -A --force && git write-tree` is the same abort. Do not treat an
empty-tree SHA from this path as a valid identity.

Do **not** leave `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, or
`GIT_ALTERNATE_OBJECT_DIRECTORIES` exported in the shell that later launches a check.
`git rev-parse --local-env-vars` names all three as repository-local overrides. After
the recipe deletes those scratch paths, a following `git status` (or any git-using
required check — this spec's own examples include `git diff --check`) inherits the
stale paths and Git 2.43 reports `fatal: not a git repository`, exit 128. Run the
measurement in a **subshell** as above, or **unset** all three before launching any
check. Deleting the files without unsetting the variables is not enough.

This spec rejects restricting `--force` to an enumerated, per-check declared-inputs
pathspec instead: an allowlist would require defining, per check, exactly which paths that
check can see — a new concept this spec deliberately avoids elsewhere (the
content-completeness discussion below states this spec "does not attempt to define [the
check-visible-content boundary] generically"). An isolated object database keeps the
existing blanket "stage everything Git's index can hold, ignored or not" model unchanged and fixes the
persistence problem by discarding the write location, not by narrowing what gets staged.

This bound covers the object database only — it does **not** claim any stronger isolation
than that. It does not sandbox the check's own process, does not prevent a check from
reading a real `.env` directly off the working-tree filesystem during its own execution
(tree-identity computation and a check's execution are different operations against the
same working tree), and does not address disk usage beyond promptly deleting the scratch
directory. Isolation here means exactly one thing: the observer's own identity-measurement
machinery leaves no new object behind in the real, persistent `.git/objects` — nothing more.

Staging into the real index right before a check runs would mutate the very state that
check is about to observe: a check sensitive to staged/unstaged distinctions (`git diff
--check`, a pre-commit hook reading the index, any tool branching on `git status`'s
staged/unstaged sections) could then see a state the identity measurement itself created,
not the candidate's actual state. Because the measurement never touches the real index, the
check that runs immediately after always starts from the same real working-tree/index state
the measurement found, not one the measurement altered.

**Real-index precondition.** A temporary index for measurement (above) stops the
*measurement* from mutating what a check observes, but it does not by itself make the real
index's own staged/unstaged state part of `candidateIdentity`: two checkouts with
byte-identical working-tree content — one with a change staged, one with the same change
left unstaged — produce the same scratch `write-tree` result (the temporary index always
runs `git add -A --force` regardless of the real index's prior state), yet an
index-sensitive check (`git diff --check` vs. `git diff --cached --check`) can return
different results against those two real-index states. This spec resolves that by
**constraint, not by adding a second identity**: the observer **must** keep the real index
clean — exactly equal to `baseRevision`'s tree (or the candidate commit's tree, for a
`commit` candidate) with nothing staged — before any required check runs, and must not
stage anything into the real index during the run. A `tree` candidate's content is
therefore always unstaged working-tree modifications on top of an otherwise-clean index;
there is exactly one legal real-index state for a given `candidateIdentity`, so nothing
further needs recording or comparing. This is a documented precondition on the observer's
fixed procedure (see roles, above) — evidence produced while the real index was not clean
is invalid even if `candidateIdentity`/`preCheckTree`/`postCheckTree` otherwise match — not
a new recorder-verified field, and this spec does not also record or verify a separate,
index-shaped identity alongside `candidateIdentity`.

`--force` still applies to whichever index and object database are used, staging
otherwise-`.gitignore`d paths a check can still read; a check can read generated output,
local fixtures, or config that
`.gitignore` hides from plain `git add -A`, and two working trees can otherwise share a
tree identity while producing different check results. If a check's inputs are produced by
a generation step, that step must run and its output must exist on disk before the tree is
computed, or the tree is not content-complete for that check. Content a check genuinely
cannot see (e.g. build caches no tool reads) is out of scope for content-completeness; this
spec does not attempt to define that boundary generically, and the fixture-only increment
sidesteps it by using a disposable fixture with no such content.

**Commit-kind extra-paths precondition.** For a `commit` candidate, `candidateTree` is
`<value>^{tree}` — the committed tree, containing exactly the tracked content at that
commit. Every `preCheckTree`/`postCheckTree` measurement, and every `tree`-kind
`candidateIdentity`, is computed via `git add -A --force` into the scratch index and
scratch object store, which stages **all** untracked and gitignored check-visible paths
Git's index can hold (empty directories are rejected, not staged). Those two trees can
never be equal whenever any extra check-visible path exists on
disk (`node_modules/`, `.env`, build output — virtually every real checkout, including
this repo's own `goal-gen/node_modules/`). The recheck rule (`preCheckTree` ≠
`candidateTree` → `PRECHECK_TREE_MISMATCH`, exit 1, never recordable) would then fire on
every check of every `commit`-kind candidate. This spec does **not** drop `--force` to
make the trees match by omitting extras — that would re-open the content-completeness gap
above. It also does **not** invent a second identity that folds committed plus extra
paths under `kind: commit`. Instead, the same pattern as the real-index precondition
applies: if any extra check-visible (untracked or gitignored) path exists, the observer
**must** set `candidateIdentity.kind` to `tree` — the observer-measured, `--force`-complete
tree. A `commit` candidate is valid **only** when that extra-path set is empty, so
`<value>^{tree}` equals the `--force`-complete measurement. This is an explicit
usability narrowing, not a buried side effect: `commit`-kind is unusable on most real
checkouts, including a disposable fixture derived from this repository while
`node_modules/` is present; those checkouts use `tree`. Evidence that records
`kind: commit` while extra check-visible paths exist is invalid — the git-free recorder
surfaces it as `PRECHECK_TREE_MISMATCH` when the honest observer supplies `<value>^{tree}`
as `candidateTree`.

**Submodule precondition.** A submodule's entry in the superproject's tree is a
**gitlink** — the committed HEAD SHA of the submodule at check-in time — never the
submodule's own working-tree content. `git write-tree` (real or scratch, per the isolated
object database above) captures a gitlink identically either way, and `--force` does not
change this: a gitlink is not a regular tracked path `--force` can pull dirty content into.
A check that reads or mutates an uncommitted change inside a checked-out submodule can
therefore leave the superproject-level `candidateTree`/`preCheckTree`/`postCheckTree`
completely unchanged, silently defeating the recheck rule for exactly the content a
submodule-aware repository cares about. Git cleanliness (`git submodule status`, inner
porcelain without `--ignored`) also misses **ignored** files and other extra
check-visible paths inside the submodule: they do not dirty the inner index or move the
gitlink, while a later check can still see them. This spec does **not** add a recursive
submodule identity — walking into each (possibly nested) submodule, computing its own
tree, and folding that into a combined identity is real design growth past a fixture-only,
disposable-git-fixture increment. Instead, the same pattern as the real-index precondition
above applies, at **two** points:

- **Before measurement.** The observer **must** reject the fixture — refuse to compute an
  identity or run any check — if any registered submodule in the working tree has
  uncommitted changes (a dirty working tree or a dirty index inside the submodule) **or**
  extra check-visible paths (ignored files, or any other untracked or gitignored path a
  check can see) before measurement begins. A dirty submodule, or a submodule with extra
  check-visible paths, is not a valid candidate for this fixture-only increment.
- **After every launched check.** The observer **must** re-verify that every submodule is
  still clean **and** still has no extra check-visible paths. A check that starts from
  that set and leaves a submodule dirty, or leaves an extra ignored or otherwise
  check-visible path inside one, mutated candidate content the superproject trees cannot
  see (`preCheckTree` can still equal `postCheckTree` because the gitlink did not move).
  That is the same leftover mutation path as a changed `postCheckTree` (see the
  recheck-rule bound below): the row is `blocked` with `reason: "candidate mutated by
  check"`, never `passed` or `failed`. `not-run` rows skip this re-verify — nothing
  launched. A check that creates such a path, uses it, and removes it before the post
  snapshot is invisible here — that is the leftover-endpoint bound
  (restore-before-post-snapshot). This spec does **not** add a during-check detector for
  that case.

This is a documented reject, not a gap papered over by a stronger identity this spec does
not build.

**Embedded-repository precondition.** An untracked nested git repository is not a
registered submodule. `git add -A --force` still records it as a mode-160000 **gitlink**
at the nested `HEAD` (`warning: adding embedded git repository`) even though
`git submodule status` has no `.gitmodules` mapping for the path. Edits inside that
nested working tree leave the superproject `write-tree` SHA unchanged — the same gitlink
hole as the submodule precondition, for a class that precondition does not name.
`git init` inside an already-tracked directory is a second hole of the same family:
`write-tree` is unchanged (the nested `.git` is not recorded as a gitlink; `ls-files`
still shows the tracked files as `100644`), while later `git -C` sees a different
repository. This spec does **not** recursively hash nested working trees. Instead, the
same two-point pattern as the submodule / empty-directory preconditions applies:

- **Before measurement.** The observer **must** reject the fixture — refuse to compute an
  identity or run any check — if any embedded git repository (a nested `.git` that is not
  a registered submodule) exists in the working tree before measurement begins. An
  embedded repository is not a valid candidate for this fixture-only increment.
- **After every launched check.** The observer **must** re-verify that no embedded git
  repository remains. A check that starts from a fixture with no nested `.git` and
  leaves one is leftover mutation the trees cannot see (`preCheckTree` can still equal
  `postCheckTree`, including when `git init` ran inside an already-tracked directory).
  That is the same leftover mutation path as a changed `postCheckTree` (see the
  recheck-rule bound below): the row is `blocked` with `reason: "candidate mutated by check"`,
  never `passed` or `failed`. `not-run` rows skip this re-verify — nothing
  launched. A check that creates a nested `.git`, uses it, and removes it before the
  post snapshot is invisible here — that is the leftover-endpoint bound
  (restore-before-post-snapshot). This spec does **not** add a during-check detector or
  a recursive nested identity for that case.

This is a documented reject, not a gap papered over by a stronger identity this spec does
not build.

**Escaping-symlink precondition.** Git stores a symlink as mode `120000` and the
**pathname text** of the target, not the bytes a process reads through the link. A
symlink whose target is outside the working tree (an absolute path, or a relative path
that resolves outside the worktree root) can change those bytes while
`candidateTree`/`preCheckTree`/`postCheckTree` stay identical — the same
content-completeness hole as a gitlink, for a class no earlier precondition names.
This spec does **not** recursively dereference symlinks or hash external target
content. The observer **must** reject the fixture — refuse to compute an identity or
run any check — if any symlink in the working tree has an escaping or out-of-tree
target, before measurement begins. An escaping symlink is not a valid candidate for
this fixture-only increment.

**Empty-directory precondition.** Git creates no index entry for an empty directory.
`git add -A --force` plus `write-tree` (real or scratch) is unchanged when an empty
directory is added or removed: a later check can still see it (`test -d`) while
`candidateTree`/`preCheckTree`/`postCheckTree` stay identical. **Retraction:** an
earlier revision of this section claimed `--force` stages "every check-visible path";
that overstated what Git's index can hold. Empty directories are **rejected, not
staged**. This spec does **not** add a filesystem directory manifest — folding
directory presence into a second identity is real design growth past a fixture-only
increment. Instead, the same two-point pattern as the submodule precondition applies:

- **Before measurement.** The observer **must** reject the fixture — refuse to compute
  an identity or run any check — if any empty directory exists in the working tree
  before measurement begins. An empty directory is not a valid candidate for this
  fixture-only increment.
- **After every launched check.** The observer **must** re-verify that no empty
  directory remains. A check that starts from a fixture with no empty directories and
  leaves one is leftover mutation the trees cannot see (`preCheckTree` can still equal
  `postCheckTree`). That is the same leftover mutation path as a changed
  `postCheckTree` (see the recheck-rule bound below): the row is `blocked` with
  `reason: "candidate mutated by check"`, never `passed` or `failed`. `not-run` rows
  skip this re-verify — nothing launched. A check that creates an empty directory,
  uses it, and removes it before the post snapshot is invisible here — that is the
  leftover-endpoint bound (restore-before-post-snapshot). This spec does **not** add a
  during-check detector for that case.

This spec defines no patch-shaped candidate identity, and `kind` has no `patch-bytes` or
similar value. Ordinary `git diff` output omits untracked files and, without `--binary`,
omits binary payloads, so a digest over an unspecified diff command's output would not
necessarily identify everything a check can see; Git `patch-id` (even `--stable`) is
deliberately whitespace-insensitive, so two patches differing only in whitespace collide
under it, letting a whitespace-sensitive check run against one candidate while the record
attributes it to another. `commit` and `tree` are both content-complete Git object
identities relative to what `git add`/`git write-tree` actually store (blob bytes after
check-in conversion, plus the executable bit they record), and a single
well-defined `kind` for each covers every candidate instead of defining a third,
patch-shaped one — but neither is a raw-filesystem-bytes identity, and neither is a
complete check-visible-metadata identity. **Retraction:** an
earlier revision of this section called `commit`/`tree` "exact content"; that overstated
what Git tree identity guarantees, and is retracted by the bounds immediately below.

**Bound: check-in conversion, not raw filesystem bytes.** `git add`/`git write-tree` apply
the repository's `.gitattributes` check-in conversions — `eol` normalization, `text=auto`,
clean filters — before a blob is stored. Two working trees whose raw filesystem bytes
differ (e.g. CRLF vs. LF on a `text=auto eol=lf`-attributed path) can produce the
**identical** tree object once Git normalizes them on the way in. This spec does **not**
add a raw-filesystem hasher to close that gap: every identity this spec defines
(`candidateIdentity`, `candidateTree`, `preCheckTree`, `postCheckTree`) is Git tree
identity **after** check-in conversion, never a byte-for-byte filesystem digest. Any
content difference `.gitattributes` normalizes away is undetectable at this bound,
including by the recheck rule below — a CRLF-normalizing formatter can leave
`preCheckTree == postCheckTree` unchanged even though the bytes a non-git-mediated tool
reads did change. This is concretely live, not hypothetical, for the disposable fixture
this spec's next increment authorizes: `goal-gen/.gitattributes` declares `* text=auto
eol=lf` today.

**Bound: Git-stored modes, not all check-visible permission bits.** For a regular file,
`git add`/`git write-tree` store only the executable bit: mode `100644` vs `100755`.
Changing 0644 to 0444 (or any other non-executable permission change Git does not
record) leaves `write-tree` unchanged; leftover endpoint trees can stay equal while a
permission-sensitive check (`stat`, a umask-aware tool) sees different bits.
Executable-bit changes are already inside Git tree identity and are not this hole.
This spec does **not** add a mode hasher, does **not** fold arbitrary permission bits
into identity, and does **not** reject fixtures for non-executable mode bits.
**Retraction:** tree equality does not cover all check-visible metadata.

`baseRevision` is the approved immutable base (commit object name). `candidateIdentity`
identifies the content actually checked, and every check row **must** repeat that exact
top-level `candidateIdentity` — no check-local override. A record's top-level `status`
cannot report `passed` by mixing checks against different candidates (e.g. tests passed on
candidate A, typecheck on candidate B): that would claim success for the record-level
candidate without any single candidate actually passing the complete required-check suite.
If a check genuinely ran against a different snapshot, evidence for it belongs in a
**separate** `acceptance record` invocation — its own fixture with its own `baseRevision`,
`candidateIdentity`, `requiredChecks`, and `checks` — never folded into this one. A fixture
that mixes per-row `candidateIdentity` values is malformed evidence; the recorder rejects
it (see the outcome table below) rather than silently splitting it into two records or
dropping the mismatched row.

**Required-check set.** The fixture declares `requiredChecks` as a non-empty array of
`{id, command, cwd}` tuples — the exact checks that must appear — before any check runs,
inside the **same** fixture JSON. Ids alone are not a binding: a fixture could declare
`requiredChecks: ["test"]` and supply a row with `id: "test"` but `command: "true"` (or
any always-succeeding stand-in) and the id-set check would still pass. This spec does
**not** add a second approved-check manifest for the recorder to cross-validate against —
that would give the recorder a second, external, trusted input and a git-or-command-runner
dependency this contract deliberately withholds (see Roles). Instead the tuples live in
the fixture, and the recorder's existing JSON-only exact-set validation extends to them:
`requiredChecks` **must be non-empty** (at least one tuple); each `id` in it must be
unique; every tuple must appear exactly once in `checks[]` matched by `id`; and that
result row's `command` and `cwd` must equal the declared tuple byte-for-byte. No
`checks[]` entry may carry an id outside `requiredChecks`. An empty `requiredChecks` (and
therefore an empty `checks[]`) would vacuously satisfy "every required check passed" with
zero observed evidence — this spec never treats missing evidence as success (VS-06/FR-17),
and a record with nothing checked is exactly that. Any violation — an empty set, a
missing, duplicated, or unexpected id, or a row whose `command`/`cwd` does not match the
declared tuple — is malformed evidence — see the outcome table below — and the recorder
writes no record rather than silently treating an unreported check as `not-run`, silently
dropping an extra one, accepting a substituted command, or aggregating zero checks into
`passed`.

**Recheck rule (mutation detection).** Repeating the same row-level `candidateIdentity`
does not by itself catch leftover endpoint mutation: a check that mutates tracked
content (lint `--fix`, a snapshot update, codegen) and *leaves* that mutation can leave
a later check, or the record itself, attributed to content it never touched.
Gitlink-invisible submodule dirt is a separate observer duty (the submodule post-check
re-verify below), not a second hasher. Every check row — whether it runs directly
against the shared working tree or against an isolated disposable copy — **must**
carry `preCheckTree` and `postCheckTree`: the working-tree object (computed exactly like a
`tree`-kind `candidateIdentity`, per above — via a temporary index and an isolated object
database, never the repository's real ones, so the measurement itself cannot alter what
the check about to run observes, and leaves no new object in the real `.git/objects`)
measured immediately before and immediately after that check's execution.

**Retraction:** an earlier revision of this rule treated `preCheckTree == postCheckTree`
as proof the check ran against unchanged content during execution. That overstated what
leftover endpoint Git tree identity guarantees, and is retracted by the bound
immediately below.

**Bound: leftover endpoint trees, not mid-check content.** This increment's mutation
detector is leftover endpoint Git tree identity (`preCheckTree` / `postCheckTree`) plus
the already-chosen submodule post-check re-verify (cleanliness **and** extra
check-visible paths inside registered submodules), the empty-directory post-check
re-verify, and the embedded-repository post-check re-verify. It detects mutations Git's
tree identity can still see after the check
exits, leftover dirty submodules, leftover extra check-visible paths inside
submodules, leftover empty directories, and leftover nested `.git` directories that are
not registered submodules; it does not detect ones `.gitattributes`
normalizes away (see the check-in-conversion bound above), it does not detect
non-executable permission-bit changes Git trees do not store (see the Git-stored-modes
bound above), and it does not detect a
restore-before-post-snapshot (including create-and-remove of an empty directory, of
an extra path inside a submodule, or of a nested `.git` before the post snapshot). A check that modifies a
tracked input, validates the modified bytes, then restores the original before the
post snapshot (mutate-validate-restore) leaves
`preCheckTree == postCheckTree == candidateTree` while the passing assertion ran
against different content. That case is invisible here, the same way `.gitattributes`
normalization and non-executable mode-bit changes are. This spec does **not** add a
filesystem watcher, an immutable check workspace, a filesystem directory manifest, a
recursive nested identity, a mode hasher, or a command
runner to close that gap. Endpoint equality is leftover tree identity after the check
exits, not proof working content was unchanged *during* the check.

- If `preCheckTree` does not equal `candidateTree` (the observer-resolved tree for
  `candidateIdentity`, per Candidate identity above — **not** `HEAD`: resolving `HEAD`
  again only re-identifies the same commit object and would not detect an uncommitted
  mutation, which is exactly why the observer resolves and supplies `candidateTree` up
  front rather than the recorder deriving it), the check never validly started against
  that candidate — a prior check likely leaked a mutation despite isolation, or the
  checkout was wrong. This is malformed evidence, not a recordable check outcome.
- If `preCheckTree` matches but `postCheckTree` differs, leftover Git tree identity after
  the check differs from before it. That is leftover mutation this detector can see, not
  proof of when during the check the bytes changed. **Isolation only bounds which
  *other* checks a leftover mutation can leak into — it does not exempt a check from this
  comparison, and discarding an isolated copy after execution does not by itself prove
  the original candidate passed.** That check's row is `blocked` with
  `reason: "candidate mutated by check"`, never `passed` or `failed`, regardless of exit
  code.
- After every launched check the observer **must** also re-verify submodule cleanliness
  **and** the absence of extra check-visible paths inside every registered submodule
  (see the submodule precondition above), that no empty directory remains (see the
  empty-directory precondition above), and that no embedded git repository remains
  (see the embedded-repository precondition above). If any submodule is dirty, any extra
  check-visible path remains inside a submodule, any empty directory remains, or any
  nested `.git` that is not a registered submodule remains, and
  the superproject trees still match, that is the same leftover mutation this detector
  already chose to catch at the post-check re-verify: `blocked` with
  `reason: "candidate mutated by check"`, never `passed` or `failed`. The recorder,
  being git-free, sees only the resulting row — it does not inspect submodules,
  directories, or nested `.git` itself. This spec still does **not** recursively hash
  submodule or nested working trees and does **not** add a filesystem directory
  manifest. `not-run` rows skip this
  re-verify.
- Crediting the resulting content (candidate B) requires a **separate `acceptance record`
  invocation for B** — its own fixture, with `candidateIdentity` set to B and a fresh check
  observation whose own `preCheckTree` equals B (per the no-mixed-candidates rule above). A
  row inside the *original* (candidate-A) record that merely relabels the mutating check's
  own exit result under B's identity, with no actual rerun starting from B, is invalid
  evidence and the recorder rejects it.

A check recorded `passed` or `failed` for a `candidateIdentity` without matching
`preCheckTree`/`postCheckTree` measurements is not valid evidence for that candidate: a
mutated tree must not count as the original candidate passing, and a copied exit result
must not count as B having been checked.

**Record shape (minimum):**

```json
{
  "schemaVersion": "yellow-goal/acceptance-evidence/v1",
  "baseRevision": "<approved base commit SHA>",
  "candidateIdentity": { "kind": "commit", "value": "<40-hex SHA-1 or 64-hex SHA-256 commit>" },
  "candidateTree": "<same-length tree object name, observer-resolved>",
  "requiredChecks": [
    {"id": "typecheck", "command": "npm run typecheck", "cwd": "goal-gen"},
    {"id": "lint", "command": "npm run lint", "cwd": "goal-gen"},
    {"id": "test", "command": "npm test", "cwd": "goal-gen"}
  ],
  "status": "blocked",
  "checks": [
    {
      "id": "typecheck",
      "status": "passed",
      "command": "npm run typecheck",
      "cwd": "goal-gen",
      "candidateIdentity": { "kind": "commit", "value": "<40-hex SHA-1 or 64-hex SHA-256 commit>" },
      "preCheckTree": "<same-length tree object name>",
      "postCheckTree": "<same-length tree object name>",
      "exitStatus": 0
    },
    {
      "id": "lint",
      "status": "not-run",
      "command": "npm run lint",
      "cwd": "goal-gen",
      "candidateIdentity": { "kind": "commit", "value": "<40-hex SHA-1 or 64-hex SHA-256 commit>" },
      "reason": "never launched"
    },
    {
      "id": "test",
      "status": "blocked",
      "command": "npm test",
      "cwd": "goal-gen",
      "candidateIdentity": { "kind": "commit", "value": "<40-hex SHA-1 or 64-hex SHA-256 commit>" },
      "preCheckTree": "<same-length tree object name>",
      "signal": "SIGTERM",
      "reason": "killed by timeout"
    }
  ]
}
```

The `kind: commit` values in this shape illustration are valid only for a fixture with
no extra check-visible paths (see the extra-paths precondition). A fixture derived from
this repository while `node_modules/` is present must use `kind: tree`. Each
`checks[]` row's `command`/`cwd` must repeat the matching `requiredChecks` tuple.

`preCheckTree` is required on every launched check (any status but `not-run`);
`postCheckTree` is required whenever `status` is `passed` or `failed`, and optional for
`blocked` rows (a killed process's post-execution tree may not be meaningful to capture).
`not-run` rows omit both — nothing started, so there is nothing to measure. This is a short
proposed contract, not a runtime design rewrite.

### Outcome table (authoritative — supersedes any conflicting description above)

| Case | Check `status` | Record written | stdout | stderr | exit |
|---|---|---|---|---|---|
| Normal zero exit, no detected leftover mutation (unchanged leftover endpoint trees, no dirty submodule, no leftover extra check-visible path inside a registered submodule, no leftover empty directory, no leftover nested `.git` that is not a registered submodule) | `passed` | yes | JSON record | empty | 0 |
| Normal nonzero exit, no detected leftover mutation (same leftover-mutation detectors as the row above) | `failed` | yes | JSON record | empty | 0 |
| Timeout / signal — launched, no Node exit code | `blocked` (never `not-run`, never `passed`) | yes | JSON record | empty | 0 |
| Never launched | `not-run` (never `blocked`) | yes | JSON record | empty | 0 |
| Missing or empty required-check set — a `requiredChecks[].id` absent from `checks[]`, or `requiredChecks` has zero entries | n/a — fixture incomplete | no | empty | `{"error":{"code":"MISSING_REQUIRED_CHECK"` \| `"EMPTY_REQUIRED_CHECKS",...}}` | 1 |
| Duplicate, unexpected, or binding-mismatched check — a duplicate or unexpected `id`, or a `checks[]` row whose `command`/`cwd` does not exactly match the `{id, command, cwd}` tuple declared for that id in `requiredChecks` | n/a — fixture ambiguous | no | empty | `{"error":{"code":"DUPLICATE_CHECK_ID"` \| `"UNEXPECTED_CHECK_ID"` \| `"CHECK_BINDING_MISMATCH",...}}` | 1 |
| Candidate mismatch — a check row's `candidateIdentity` ≠ the record's | n/a — fixture invalid | no | empty | `{"error":{"code":"CANDIDATE_MISMATCH",...}}` | 1 |
| Pre-check candidate mismatch — `preCheckTree` ≠ `candidateTree` before the check even started (per the recheck rule's first bullet) | n/a — the check never validly started against the recorded candidate; **never** a recordable check outcome | no | empty | `{"error":{"code":"PRECHECK_TREE_MISMATCH",...}}` | 1 |
| Leftover candidate mutation — `preCheckTree` **equals** `candidateTree`, but `postCheckTree` differs from `preCheckTree`, **or** a submodule is dirty after the launched check, **or** an extra check-visible path remains inside a registered submodule after the launched check, **or** an empty directory remains after the launched check, **or** a nested `.git` that is not a registered submodule remains after the launched check, even though the superproject trees match (per the recheck-rule bound and the submodule / empty-directory / embedded-repository post-check re-verifies). Endpoint inequality is leftover Git tree identity after the check exits, not proof of when during the check the bytes changed. | `blocked`, `reason: "candidate mutated by check"`, **if reported honestly**; fixture-invalid if the row still claims `passed`/`failed`, or if a later row credits the resulting content without an independently rerun check | yes when honestly reported as `blocked`; no when mislabeled or uncredited | JSON record / empty | empty / `{"error":{"code":"INVALID_STATUS_FOR_MUTATED_CANDIDATE"` \| `"UNVERIFIED_CANDIDATE_CREDIT",...}}` | 0 / 1 |
| Malformed evidence — schema-invalid fixture (missing/mistyped required field) | n/a | no | empty | `{"error":{"code":"SCHEMA_INVALID",...}}` | 1 |
| Recorder I/O failure — cannot persist the record | n/a | no | empty | `{"error":{"code":"IO_ERROR"` \| `"UNEXPECTED_ERROR",...}}` | 1 |

A pre-check mismatch and leftover candidate mutation are **never the same row**: the first
means the check's evidence for this candidate was never valid in the first place (exit 1,
no record, ever); the second means the check validly started against the candidate and the
leftover endpoint trees (or post-check submodule cleanliness / extra submodule
paths, a leftover empty directory, or a leftover nested `.git`) differ after it (exit 0, a recordable
`blocked` result, when honestly reported).
A submodule left dirty, an extra check-visible path left inside a registered
submodule, an empty directory left behind, or a nested `.git` that is not a
registered submodule left behind after a launched check is that
second case even when the superproject trees still match. Rows 1–2 apply
**only** when those leftover-mutation detectors report none; the same
observation with a detected leftover mutation is **row 9** (`blocked`), not
`passed` or `failed`. That is case qualification — which row describes the
observation — not a least-favorable ordering among `passed`/`failed`/`blocked`.
Folding the two into one row — as an earlier revision of this table did, with a combined
"diverge (or don't match the candidate)" case and a single "if reported honestly" gate —
contradicted the recheck rule's own prose, which gives the pre-check case no honest-recording
path at all. Both rows above match the recheck rule exactly; this table's authority applies
to case boundaries, not to overriding which cases exist.

**Aggregate.** The record's top-level `status` is not a process and carries no
`exitStatus`; only rows 1–4 and the honestly-reported half of row 9 above ever become part
of a written record (rows 5, 6, 7, 8, 10, and 11 never produce one). The aggregate is derived
solely from those already-validated check-row statuses: `passed` only when every required
check's `status` is `passed`. Otherwise the aggregate takes the highest-precedence
non-passed status present, using the fixed precedence **`blocked` > `failed` >
`not-run`** — `blocked` outranks `failed` because it means the evidence itself cannot be
trusted for that candidate (a killed process or a mutated tree, not a clean negative
result); `failed` outranks `not-run` because a normal nonzero exit is trustworthy negative
evidence about the candidate, while `not-run` means nothing was even attempted. This fixed
order replaces any undefined "least favorable" judgment call. An otherwise valid record in
which every required check exited `0` is a valid `passed` record even though the aggregate
itself carries no `exitStatus` to check.

## Observed fixture verification increment (3b)

Authorized follow-on to the layer-3 recorder. This is **not** verified single-milestone
execution completed and is **not** layer 4. Do not rewrite ADR-0018 decision text.

**Product outcome.** An engine-owned fixed profile plus an approved fixture base and a
controlled candidate/diff are materialized in a **disposable git repository** (never the
live yellow-goal or yellow-plugins checkout). The observer runs only that profile's fixed
local checks, measures trees per the recheck rule above, writes an internally consistent
`yellow-goal/acceptance-evidence/v1` fixture, and invokes the **packed/installed**
`acceptance record` binary as a subprocess. A separate decider then emits a
fixture-scoped decision and a reconstructable bundle. Recorder exit 0 remains necessary
evidence, never acceptance.

### Supported envelope

| Field | Contract |
|---|---|
| Profile | Engine-owned (`id`, `version`, required check IDs, implementations/args, cwd, timeout bounds, base files, variants, approved candidate overlay). Lives next to the CLI, outside candidate-writable content. |
| Variant | Named overlay of candidate files onto the profile base. Cannot add, remove, or retarget required checks. |
| Required checks | Profile `{id, argv, cwd, command}` — `argv` is the only execution vector. The `command` string is recorder-facing identity, never passed to a shell. |
| Candidate identity | Observer-measured `kind: tree` (disposable fixtures include extra check-visible content such as `STATUS`). |
| Targets | Disposable repos under `$TMPDIR` only. |

### Process interface

Verb: `acceptance verify-fixture <profile-id> <variant-id> [--json]`

Dynamically imported. Not a Protocol v1 capability. Does not load `run-command`.

| Property | Contract |
|---|---|
| stdout | One JSON bundle `yellow-goal/observed-fixture-verification/v1` when the workflow finishes (affirmative **or** negative decision). Empty on usage/I/O failure, including a signaled recorder. |
| stderr | Structured `{"error":{"code","message"}}` on usage (exit 2) or I/O/unexpected (exit 1) only. Empty when a bundle is written. `RECORDER_INVOKE_FAILED` is exit 1. |
| Recorder | Child process: `goal-gen acceptance record <fixture.json> --json` via `bin/goal-gen.mjs`. The workflow does **not** import the recorder. |
| Exit 0 | Bundle written. Includes valid negative records and `accepted: false`. |
| Exit 1 | No bundle: I/O or unexpected infrastructure failure. |
| Exit 2 | Usage (wrong arity, unknown profile/variant). |

There is **no** `--fixture`, `observed:true`, or imported-JSON authorization route.

### Trust boundary

- **Engine-owned:** profile, argv, timeout, approved overlay, check implementations.
- **Candidate-writable:** disposable working tree only.
- **Observer** measures trees (temporary index, isolated object store, `git add -A --force`), keeps the real index clean, rejects escaping symlinks / empty directories / nested `.git` / dirty submodules **before** measurement, and re-verifies those after every launched check. Check subprocesses use a **minimal deliberate env** (controlled `HOME`/`TMPDIR`/`PATH` of explicit tool dirs, `GIT_CONFIG_GLOBAL` + `GIT_CONFIG_NOSYSTEM`, synthetic `GOAL_GEN_DISPOSABLE_OBSERVER` only). Host env is not copied. Disposable `HOME` is not a network sandbox.
- **Observer child lifecycle:** drain stdout/stderr with an **encoded-byte** bound (UTF-8 `StringDecoder`, including sequences split across chunks); stop collecting once the bound is hit. Escalate SIGTERM → SIGKILL based on **completion**, not `child.killed` (delivery ≠ exit); preserve the actual close `signal`/`exitStatus` plus independent `deadlineExceeded`. Do not substitute `signal ?? 'SIGTERM'`. On supported POSIX platforms, spawn the owned child in its own process group and kill that group (then destroy the parent's pipe ends) so a descendant that inherits stdout/stderr cannot hang `close`. Do not signal unrelated process groups. Timeout fixtures signal readiness (via `GOAL_GEN_OBSERVER_READY`, a file **outside** the measured tree) after installing handlers; the behavioral deadline starts only then, so Node startup cannot consume the 200 ms bound. If readiness never arrives, or the owned child exits before the ready file exists, record `readiness-failed` with the actual close status and do not treat that exit as passed. Readiness-budget expiry is not an execution deadline: do not set `deadlineExceeded`. Latch a `waitForReadyFile` `timeout` result; a ready marker that appears afterwards must not drop `readiness-failed` or turn the kill into an ordinary signal. A late poll after the readiness budget has elapsed is `timeout` even if the marker is present on that tick; evaluate elapsed time before accepting the marker. Kill the owned tree when it is still running. `timeout-probe` exits 0 **synchronously** in its SIGTERM handler so the 250 ms SIGKILL grace cannot win a deferred-exit race. Cancellation of `runBoundedArgv` uses the same owned-tree kill path and does not invent an exit code.
- **Recorder** stays git-free and command-free. The child is given a PATH trap so a regression that shells out to `git` or the fixture `command` string fails the sentinel; the workflow asserts those marker files were **not** created. Recorder stdout/stderr is size- and deadline-bounded. A recorder that dies on a signal or otherwise lacks a numeric `exitStatus` is `RECORDER_INVOKE_FAILED`: structured stderr, workflow exit 1, **no** fabricated `recorder.exit` and **no** verify-fixture bundle. Honest numeric recorder exit 1 remains a negative bundle with workflow exit 0. Invocation tempdir cleanup covers setup failure.
- **Decider** reads the observer's provenance plus the recorder subprocess result. Hand-authored all-passed JSON may be valid **recorder** input and still cannot produce an affirmative decision from this verb.
- `implementationRevision` is `goal-gen@<package-version>#<sha256>` over engine sources (executed CLI boundary `bin/goal-gen.mjs` / `index.ts` / `direct-invocation.ts` / `commands.ts` / `errors.ts`, plus observer/recorder/profile-policy modules — not the unrelated tree or unrelated CLI imports) plus a portable profile digest of logical checker identities (script basename, extra argv, readiness, checker bytes), `approvedFiles`, and profile policy — not `process.execPath` or install-directory prefixes. Do not hash `node_modules`. Node plus resolved versions of material runtime dependencies (`tsx`, `zod`, from those packages' installed `package.json`) are recorded separately as a **label**, not hashed into that identity and not implied measured coverage. The entry-script guard is hashed because it can skip or double-invoke `main()` without a version bump.
- Observation faults (precondition violation, measurement abort of the **candidate identity**) are workflow blockers: `accepted: false`, recorder not invoked, **no** invented recorder fields. Per-check spawn or pre-measurement failure **after** that candidate tree was measured is not an observation fault: it produces honest `not-run` rows (later checks `not-run`); the recorder is invoked when the fixture is otherwise representable.

### Outcome table

| Case | Observer | Recorder subprocess | Decision | Workflow exit |
|---|---|---|---|---|
| Failing baseline (required check nonzero, no leftover mutation) | real failed row | record written, aggregate `failed`, exit 0 | `accepted: false` | 0 |
| Approved/correct candidate, all required checks pass, no leftover mutation, overlay matches | real passed rows | record `passed`, exit 0 | `accepted: true` | 0 |
| Incorrect candidate (real check fails) | real failed row | record `failed`, exit 0 | `accepted: false` | 0 |
| Timeout that actually delivers SIGKILL/SIGTERM | launched, `blocked` + actual `signal`, no `exitStatus`, `deadlineExceeded` | record `blocked`, exit 0 | `accepted: false` | 0 |
| Timeout then later normal exit (no actual signal) | launched, `blocked` + `reason: deadline-exceeded`, raw exit preserved on the bundle, **no invented `signal`** | **not invoked** (v1 cannot carry deadline + numeric exit honestly) | `accepted: false` | 0 |
| Noisy output truncated | launched, `blocked` + `reason: output-truncated` | **not invoked** | `accepted: false` | 0 |
| Spawn / pre-measurement failure of a required check | `not-run` (never launched); later checks `not-run`; candidate tree present | record `not-run`, exit 0 | `accepted: false` | 0 |
| Readiness never signaled, including exit before the ready file | launched, `blocked` + `reason: readiness-failed`, actual close `signal`/`exitStatus`, **no** `deadlineExceeded` | record when representable; **not invoked** when the close is a numeric exit without a signal | `accepted: false` | 0 |
| Owned descendant holds inherited pipes after the direct child exits | launched, bounded collection, owned process-group cleanup on supported platforms, actual close status (no invented `signal`) | same honesty rule as timeout / truncated | `accepted: false` | 0 |
| Leftover mutation then remaining checks | completed row `blocked`; later rows `not-run` | record written when representable | `accepted: false` | 0 |
| Leftover mutation (changed tree, empty dir, nested `.git`, dirty submodule) | `blocked` + `candidate mutated by check` | record `blocked`, exit 0 | `accepted: false` | 0 |
| Observation fault (escaping symlink, empty dir / nested `.git` / dirty submodule **before** start, measurement abort) | no honest fixture | **not invoked** | `accepted: false` | 0 |
| Hand-authored all-passed JSON | n/a | valid `acceptance record` input | cannot substitute for this verb | n/a |
| Unknown profile/variant or imported JSON path | n/a | not invoked | no bundle | 2 |
| Recorder killed by signal (or missing numeric exit) | observation complete | **not a recorder result** — throw `RECORDER_INVOKE_FAILED` | no bundle | 1 |

### Requirement-to-test mapping

| ID | Requirement | Test |
|---|---|---|
| OF-01 | Engine-owned profile; candidate cannot redefine required checks | `observed-fixture.test.ts` |
| OF-02 | Disposable repo only; argument-vector spawn; no shell interpolation | same |
| OF-03 | Trees via temporary-index + isolated object store + `--force` | same |
| OF-04 | Empty-dir / nested `.git` / escaping symlink / submodule re-verifies | same |
| OF-05 | Timeout stays `blocked`; later exit 0 does not invent `SIGTERM`; SIGKILL is used when the child ignores SIGTERM | same |
| OF-06 | Packed/installed `acceptance record` is a subprocess | `observed-fixture.test.ts` + `install-smoke.sh` |
| OF-07 | Failing baseline, correct candidate, incorrect candidate from real observations | same |
| OF-08 | Valid negative record is not acceptance | same |
| OF-09 | Hand-authored all-passed JSON records but cannot authorize this workflow | same |
| OF-10 | Observation fault does not invent recorder fields | same |
| OF-11 | Compiler cold path does not load observer; observer does not load `run-command` | isolation tests |
| OF-12 | Owned descendant pipe lifetime, readiness failure distinct from post-ready `deadlineExceeded`, latched readiness-budget timeout, cancellation, encoded-byte bounds | `observed-fixture.test.ts` + `observed-fixture-child.test.ts` |
| OF-13 | `implementationRevision` covers recorder/validator/profile policy/trusted checkers plus executed CLI boundary including the entry-script guard; a recorder, checker, or boundary-source change changes identity; install path and Node executable do not; Node plus resolved `tsx`/`zod` versions are a separate runtime label (not hashed, not `node_modules` bytes) | `observed-fixture.test.ts` |
| OF-14 | Signaled recorder (no numeric exit) is `RECORDER_INVOKE_FAILED`; no bundle; CLI exit 1. Honest numeric recorder exit 1 still emits a negative bundle | `observed-fixture.test.ts` |

## Candidate-bound offline milestone increment (3c)

Authorized follow-on to layers 3 and 3b. This is **candidate-bound offline milestone implemented**, not verified single-milestone execution completed, and **not** layer 4. Do not rewrite ADR-0018 decision text.

**Product outcome.** One engine-owned profile owns the base, milestone identity, allowed paths, fixed checkers/argv/bounds, and semantic requirements. A caller-supplied **FILE-CONTENT** candidate document is untrusted proposed data — not evidence, not authorization. The observer materializes those files onto a disposable repo, runs the profile's fixed checks, records through packed `acceptance record`, and emits a fixture-scoped decision. A durable bundle survives temp-repo deletion and directory move. Fresh-process `acceptance reproduce` reconstructs the measured tree and **reruns** trusted checks from the **installed** package. Parsing stored `accepted: true` is not re-verification.

### Supported envelope

| Field | Contract |
|---|---|
| Profile | Engine-owned (`config-repair` in this increment): base files, allowed paths, ≥2 required checks, argv/cwd/timeout, semantic requirements. Lives next to the CLI, outside candidate-writable content. |
| Candidate document | `yellow-goal/candidate-file-content/v1` `{ files: { relativePath: string contents } }`. The **file** is read with an encoded-byte cap (`maxDocumentBytes`) **before** `JSON.parse`. Paths validated for size/depth/traversal before materialization. Only `allowedPaths` may be written. |
| Required checks | Profile `{id, argv, cwd, command}` — same observer as 3b. Checkers are not loaded from the candidate or the bundle. |
| Candidate identity | Observer-measured `kind: tree`. |
| Targets | Disposable repos under `$TMPDIR` only. No arbitrary repos, archives, scripts, URLs, or caller checkers. No eval/install of candidate code. |

There is **no** golden `approvedFiles` equality gate on this path. ≥2 byte-distinct valid candidates can both satisfy the same semantic requirements.

### Process interface

Verbs:

- `acceptance verify-candidate <profile-id> <candidate.json> [--json] [--bundle-dir <dir>]`
- `acceptance reproduce <bundle-dir> [--json]`

Dynamically imported. Not a Protocol v1 capability. Does not load `run-command`. Existing `acceptance record` and `acceptance verify-fixture` stay intact.

| Property | Contract |
|---|---|
| stdout | One JSON bundle `yellow-goal/candidate-offline-milestone/v1` when the workflow finishes (affirmative **or** negative). Empty on usage/I/O failure. |
| stderr | Structured `{"error":{"code","message"}}` on usage (exit 2) or I/O/unexpected (exit 1) only. |
| `--bundle-dir` | Must be missing or an **empty** directory (created if needed). Never overwrites a non-empty user path. Writes `manifest.json` then atomically renames `COMPLETE`. |
| Recorder | Packed `acceptance record` subprocess, same as 3b, omitted when v1 cannot represent the observation honestly. |
| Exit 0 | Bundle written (in-memory always; durable when `--bundle-dir` is given). Includes valid negatives and `accepted: false`. |
| Exit 1 | No durable success marker: I/O, incomplete bundle, or unexpected infrastructure failure. |
| Exit 2 | Usage (wrong arity, unknown profile, unsafe candidate path, oversized candidate document, non-empty `--bundle-dir`). |

### Trust boundary

- **Engine-owned:** profile, argv, timeout, allowed paths, semantic requirements, checker implementations, reproduction policy.
- **Untrusted:** candidate document bytes, bundle-stored candidate bytes, bundle-stored `decision.accepted`, bundle-stored recorder JSON, bundle-stored bindings.
- **Observer / recorder / decider** roles stay separate. The candidate cannot redefine required checks, supply executable checkers, or self-assert acceptance.
- Bound the untrusted candidate **file** to `maxDocumentBytes` while reading (at most cap+1 bytes allocated). Do not `readFileSync`/`JSON.parse` an unbounded document first and then apply `maxFiles`/`maxFileBytes`. Oversized input — including a huge unknown property or whitespace — is structured `USAGE_ERROR` / exit 2, not heap death.
- `implementationRevision` is `goal-gen@<package-version>#<sha256>` over engine sources plus a portable profile digest of logical checker identities (script basename, extra argv, readiness, checker bytes), allowed paths, base files, and candidate-document limits (`maxFiles` / `maxFileBytes` / `maxDepth` / `maxDocumentBytes`) — not `process.execPath`, install-directory prefixes, or `node_modules`. Node plus resolved `tsx`/`zod` versions are a separate runtime label, not measured coverage. Tightening those limits without hashing them would let `reproduce` skip profile-drift and apply different validation (USAGE_ERROR) to a stored candidate.
- Synthetic Git base uses fixed author/committer dates (`1970-01-01T00:00:00+0000`) and a recorded recipe so the same files reproduce the same `baseRevision`.
- Reproduce loads the **installed** profile by id, compares digest, reconstructs files, and reruns checks. Bundle-supplied executables and trusted-policy fields are ignored.

### Outcome table

| Case | Observer | Recorder | Decision | Workflow exit |
|---|---|---|---|---|
| Byte-distinct valid candidate A (alpha) | both required checks passed | record `passed` | `accepted: true` | 0 |
| Byte-distinct valid candidate B (beta) | both required checks passed | record `passed` | `accepted: true` | 0 |
| Failing baseline (no overlay / still-broken config) | real failed row | record `failed` | `accepted: false` | 0 |
| Incorrect candidate | real failed row | record `failed` | `accepted: false` | 0 |
| Extra unauthorized file | not launched as authorized overlay | omitted or not-run | `accepted: false` (`unauthorized-path`) | 0 |
| Self-assert `accepted: true` in candidate data | unauthorized extra path and/or failed checks | omitted or failed | `accepted: false` | 0 |
| Candidate tries to supply a checker | unauthorized extra path | omitted | `accepted: false` | 0 |
| Unsafe path (`..`, absolute, `.git` in any segment) | n/a | not invoked | no bundle | 2 |
| Oversized candidate file (before parse) | n/a | not invoked | no bundle | 2 |
| Timeout-ignore / timeout-exit-0 / noisy / spawn / leftover-then-later / missing measurement | same as 3b table | same honesty rule | `accepted: false` | 0 |
| Durable bundle moved; temps deleted | n/a | n/a | reproduce reruns checks | 0 |
| Mutated `COMPLETE` / missing marker / non-regular or wrong-bytes `COMPLETE` | n/a | n/a | no stale success | 1 |
| Mutated bundle `decision.accepted` | n/a | n/a | reproduce ignores it and reruns | 0 |
| Profile digest mismatch vs installed | n/a | not treated as success | `accepted: false` | 0 |
| Unknown profile / missing candidate file | n/a | not invoked | no bundle | 2 |

### Requirement-to-test mapping

| ID | Requirement | Test |
|---|---|---|
| CO-01 | Engine-owned profile; candidate cannot redefine required checks | `candidate-offline.test.ts` |
| CO-02 | ≥2 required checks; ≥2 byte-distinct valid candidates; not golden `approvedFiles` | same |
| CO-03 | Failing baseline, incorrect candidate, extra file, self-assert, weaken-check | same |
| CO-04 | Path/size/depth validation before materialization; candidate file byte-capped before `JSON.parse` | same |
| CO-05 | Durable bundle + atomic `COMPLETE`; no overwrite of non-empty paths | same |
| CO-06 | Installed fresh-process reproduce reruns trusted checks | `candidate-offline.test.ts` + `install-smoke.sh` |
| CO-07 | Mutating candidate/bindings/profile/record/marker cannot stale-succeed; profile digest covers trusted invocation plus candidate-document limits including `maxDocumentBytes` | same |
| CO-08 | `implementationRevision` is not a relabeled package version | same + observed-fixture tests |
| CO-09 | Reproducible synthetic Git base from the recorded recipe | same |
| CO-10 | Compiler cold path does not load the candidate workflow | isolation tests |

## Committed-source capture increment (3d)

Authorized follow-on to layers 3, 3b, and 3c. This is **committed-repository verification implemented** (source-capture slice), not verified single-milestone execution completed, and **not** layer 4. Do not rewrite ADR-0018 decision text. Preserve `acceptance record`, `verify-fixture`, `verify-candidate`, and `reproduce`.

**Product outcome.** One engine-owned profile names a bounded allowlist of committed non-secret paths and ≥2 installed checkers. The caller names a **local** git repository and a revision. The engine resolves that revision **once** to a full 40-character commit object ID, then reads **only** those allowlisted blobs through Git object commands. Checkers run against a disposable snapshot of captured bytes (not a worktree of the source, not import/eval/`npm install` of the target). Dirty/staged/untracked/ignored source content is **uninspected**. Source non-mutation is proven with canaries (HEAD/index bytes plus planted worktree files).

### Supported envelope

| Field | Contract |
|---|---|
| Profile | Engine-owned (`package-manifest-lockfile` in this increment): allowlisted paths, ≥2 required checks, argv/cwd/timeout, `maxFiles` / `maxFileBytes` / `maxDepth`. Lives next to the CLI, outside the captured tree. |
| Target | A **local** git directory. CI and unit tests use a disposable owned fixture with known commits/blobs — they must not `rev-parse` live `main` or fetch. Real yellow-goal capture is demonstration evidence from a local clone that already has the object, not a CI pin. No GitHub URL, no network. |
| Revision | Named ref or object name, resolved once via `rev-parse` to a full commit object ID; all later reads use that ID. |
| Allowlist | `goal-gen/package.json`, `goal-gen/package-lock.json`, `goal-gen/bin/goal-gen.mjs`. |
| Required checks | `manifest-lock-agreement` (package name/version equals lockfile root/`packages[""]`; `lockfileVersion` 3) and `packaging-entry` (`package.json` `bin.goal-gen` is `bin/goal-gen.mjs`; captured blob is a regular file starting with `#!/usr/bin/env node`). Checkers are installed with the engine, never loaded from the captured tree. |
| Git | Object reads only: `rev-parse`, `cat-file`, `ls-tree`. `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1` plus `--no-replace-objects` on every object-read, `core.hooksPath=/dev/null`, no `GIT_WORK_TREE`, no checkout/index/object writes, no source worktree create, no target hooks/executables. Missing local objects fail closed without contacting a remote or writing the source object store. Blob hashes and checker snapshots use original bytes (not UTF-8 U+FFFD replacement). `--bundle-dir` must be outside the source worktree and `.git`, including when a symlink ancestor would resolve the destination into either; compare the realpath of the nearest existing ancestor. When `<repo>` is a non-bare checkout's git directory (`git -C <checkout>/.git` makes `--show-toplevel` fail), resolve the associated worktree from that git directory — do not treat the failed lookup as a bare repository (`worktree: null`). Git UTF-8 object-read stdout strips only a terminating LF, not `.trim()` and not a trailing CR, so `--show-toplevel` of a checkout whose directory name ends in whitespace or CR keeps that pathname byte. Blob reads are size-capped before content allocation. |
| Snapshot | Disposable directory under `$TMPDIR` holding captured bytes with recorded Git file modes applied (`100644` → `0o644`, `100755` → `0o755`) **before** checks run. Not a git worktree of the source. Deleted after checks. |

### Process interface

Verb:

- `acceptance capture-source <profile-id> <repo> <commit> [--json] [--bundle-dir <dir>]`

Dynamically imported. Not a Protocol v1 capability. Does not load `run-command`. Existing `acceptance record` and `verify-fixture` stay intact. `acceptance reproduce` stays the 3c replay path when `COMPLETE` is `yellow-goal/candidate-offline-milestone/v1`; capture-schema bundles are 3e.

| Property | Contract |
|---|---|
| stdout | One JSON bundle `yellow-goal/committed-source-capture/v1` when the workflow finishes (affirmative **or** negative). Empty on usage/I/O failure. |
| stderr | Structured `{"error":{"code","message"}}` on usage (exit 2) or I/O/unexpected (exit 1) only. |
| `--bundle-dir` | Same empty-directory / atomic `COMPLETE` rule as 3c, including recursive missing parents. Missing dest whose immediate parent does not exist is created by walking the nearest existing ancestor and mkdir of each missing component relative to an opened parent handle (`O_RDONLY|O_DIRECTORY|O_NOFOLLOW`), not by requiring the caller to pre-create the immediate parent. Marker bytes are this schema version. |
| Recorder | Omitted. Acceptance-evidence v1 cannot honestly represent Git-object capture without minting a candidate git identity of the source. Decision is from observed checker exits plus capture faults. |
| Exit 0 | Bundle written. Includes valid negatives (`accepted: false`). |
| Exit 1 | Source mutation detected after capture, I/O, incomplete bundle, or unexpected infrastructure failure. |
| Exit 2 | Usage (wrong arity, unknown profile, non-local repo, unresolvable revision, unsafe revision, `--bundle-dir` inside the source worktree or `.git`, non-empty `--bundle-dir`). |

### Trust boundary

- **Engine-owned:** profile, allowlist, argv, timeout, checker implementations, Git verb allowlist.
- **Untrusted:** named source repository contents, requested revision string, captured blob bytes, bundle-stored `decision.accepted`.
- **Uninspected:** dirty, staged, untracked, ignored paths. They are not part of the decision. Tests plant canaries to prove the engine did not mutate them.
- `implementationRevision` follows 3c (engine sources plus this increment's capture modules once they exist; portable checker identity; runtime label separately; no `node_modules` hash).
- Checkers must not import, `eval`, or `npm install` captured bytes.

### Outcome table

| Case | Capture | Checks | Decision | Workflow exit |
|---|---|---|---|---|
| Owned fixture at pinned commit; lockfile agrees; packaging entry present | 3 blobs | both passed | `accepted: true` | 0 |
| Lockfile name/version disagrees with manifest | blobs read | `manifest-lock-agreement` failed | `accepted: false` | 0 |
| Missing packaging entry / not a blob / missing shebang | missing or captured | `packaging-entry` failed | `accepted: false` | 0 |
| Allowlisted path absent from commit | listed in `missing` | failed | `accepted: false` | 0 |
| Unknown profile / URL repo / extra args | n/a | not launched | no bundle | 2 |
| Unresolvable revision | n/a | not launched | no bundle | 2 |
| Source HEAD/index bytes changed during capture | n/a | n/a | no bundle | 1 |
| Git write verb attempted | refused | not launched | no bundle | 1 |

### Requirement-to-test mapping

| ID | Requirement | Test |
|---|---|---|
| CS-01 | Engine-owned `package-manifest-lockfile` profile; ≥2 checks; allowlist fixed | `committed-source.test.ts` |
| CS-02 | Capture an owned git fixture at a pinned full commit object ID via Git object reads (not live `main`; real yellow-goal is demonstration evidence) | same |
| CS-03 | Manifest/lock agreement and packaging-entry both required | same |
| CS-04 | Incoherent lockfile is an honest negative | same |
| CS-05 | Dirty/untracked canaries survive; HEAD/index bytes unchanged | same |
| CS-06 | Git helper refuses non-read verbs (`checkout`, `update-index`, …) | same |
| CS-07 | Blob/document reads are byte-capped before unbounded allocation | same + candidate-offline tests |
| CS-08 | Additive capture verb; record / verify-fixture / 3c verify-candidate unchanged. `acceptance reproduce` dispatches by `COMPLETE` schema (3e). | same + isolation tests |
| CS-09 | Compiler cold path does not load capture; Protocol v1 does not advertise it | isolation + `install-smoke.sh` |

## Captured-base candidate replay increment (3e)

Authorized follow-on to layer 3d. This is **committed-repository verification implemented** (captured-base replay slice), not verified single-milestone execution completed, and **not** layer 4. Do not rewrite ADR-0018 decision text. Preserve Protocol v1, the recorder/observer/decider split, and the 3c `config-repair` verify-candidate path.

**Product outcome.** A durable capture bundle stores the **selected** allowlisted bytes (plus mode and identity metadata) that checks ran against. `acceptance reproduce <bundle-dir>` reads `COMPLETE` and dispatches: `yellow-goal/candidate-offline-milestone/v1` keeps the 3c replay; `yellow-goal/committed-source-capture/v1` reconstructs those bytes into a disposable snapshot and **reruns** the installed profile's trusted checks. Parsing stored `accepted: true` is not re-verification. An additive `--from-capture` option on `acceptance verify-candidate` overlays a FILE-CONTENT candidate onto that captured base inside an **owned** snapshot (never the source checkout). Extra files and changed check bindings cannot authorize success.

### Supported envelope

| Field | Contract |
|---|---|
| Capture bundle | `COMPLETE` bytes are this schema version plus a trailing newline, `manifest.json`, and `blobs/<allowlisted-path>` exact selected bytes. Compare the marker to that exact string; a truncated schema-without-newline is incomplete. Peek `COMPLETE` via a no-follow descriptor and `fstat` of the opened inode (not `lstat` then path-based `readFileSync`); a symlink, FIFO, or oversized swap cannot hang or consume unchecked bytes — only the exact capture/offline marker sizes are read. Missing blob files, wrong `COMPLETE`, sha256 mismatch, `stat.size` over the installed `maxFileBytes`, a selected path outside the installed profile `allowedPaths`, a duplicate selected path, a duplicate `source.captured` path, or `selected.length > maxFiles` is incomplete/invalid — no snapshot, no stale success. Persist and reproduce bound blob `stat.size` and read at most that cap before allocation; selected metadata is checked before any blob read. Bound `manifest.json` via a no-follow descriptor and `fstat` of the opened inode (not `lstat` then path-based `open`) and read at most that size before `JSON.parse`; a symlink or FIFO swap of `manifest.json` is `BUNDLE_INCOMPLETE` and must not consume planted digest bytes or hang. Each selected blob must canonicalize beneath the `blobs/` root: a symlink in any path component (including an intermediate directory such as `blobs/goal-gen`) is `BUNDLE_INCOMPLETE`, not live-host bytes. Reproduce opens the bundle directory and validated blobs by descending through `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` directory handles and `fstat` of the opened leaf — it does not `lstat` then path-based `open`. The manifest leaf uses `O_RDONLY|O_NOFOLLOW` (nonblocking so a FIFO cannot hang). Selected blob leaf open uses the same `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` flags so a FIFO swap of `blobs/goal-gen/package.json` cannot hang; `fstat` of the opened inode rejects non-regular files (`BUNDLE_INCOMPLETE`; honest unswapped COMPLETE reproduce still `accepted: true`). Overlay-listed paths still waive selected-to-captured identity, but same-sized external overlay bytes swapped after walk cannot `accepted: true` (noswap of that forged selected hash stays `BUNDLE_INCOMPLETE`). For a plain capture (`source.overlay` null) and for paths not listed in a recorded overlay, selected `sha256`/`byteLength` must match the captured row and the selected bytes must be the git blob identified by that row's `gitSha` — otherwise `BUNDLE_INVALID` before snapshot. When retained `source.identity.gitDir` still exists, each captured row's `gitSha`/`mode` must match `ls-tree` of recorded `source.commit` at that path — a coherent blob + selected + captured-row rewrite cannot `accepted: true` for a still-claimed commit. Missing, null, or relative `source.identity` during persisted-bundle validation is `BUNDLE_INVALID` — deleting identity cannot skip that commit-bind so `reproduce` cannot `accepted: true` attributing replaced bytes to original `source.commit`; gone-source (well-formed identity whose `gitDir` no longer exists) still skips the live `ls-tree` bind. `source.commit` must still be a full 40-hex object ID when `gitDir` is gone — a gone-source tamper `not-a-commit` cannot `accepted: true`; only live `ls-tree` binding depends on `gitDir` existing. Reproduce holds the bundle-root directory descriptor across `COMPLETE`, `manifest.json`, and `blobs/` — renaming dest after the inner COMPLETE peek cannot mix that marker with a replacement overlay missing COMPLETE. Every `source.captured` row must be a valid captured blob (null and malformed rows are `BUNDLE_INVALID`); the captured path set must match the selected path set before any Git calls — extra never-selected rows cannot `accepted: true` or persist COMPLETE. |
| Selected bytes | The snapshot checkers ran on. For a plain capture that is the pinned blob bytes. For `--from-capture` that is captured bytes with allowlisted overlay applied **at overlay time**, then persisted under `blobs/` with matching hashes. `acceptance reproduce` snapshots **only** those hash-validated blobs. Stored `source.overlay` text is untrusted authorization metadata (paths, plus 3c per-file byte, path, depth, and file-count caps); it is not check input and cannot substitute for blob hashes. Overlay replaces already-captured allowlisted paths only — it does not materialize allowlisted paths missing from the pinned commit. A chained `--from-capture` whose candidate omits a previously overlayed path keeps those prior overlay bytes already in `blobs/` and merges prior overlay files whose keys exist in stored blobs with the new candidate so persist overlay keys still waive identity for retained overlay bytes; original captured bytes are not rebuilt (overlay persist overwrites `blobs/`). Empty `files: {}` from an overlay dest keeps those prior keys; empty `files: {}` from a plain capture stays `{}`. Unauthorized persist merges prior overlay files whose keys exist in stored blobs with the new candidate so relocated reproduce stays `unauthorized-path` (CS-13 still `accepted: false`); extra.txt stays recorded. For a plain capture and for paths not listed in that overlay, selected bytes must match the captured row's original hash/length and Git object identity; overlayed paths may differ. Modes stay the captured blob modes; the checker snapshot applies recorded `100644`/`100755` as filesystem `0o644`/`0o755` before checks (Buffer bytes alone are not the mode contract). Identities (`gitSha`) stay the pinned commit's blobs; overlay does not mint a source git identity. |
| Overlay candidate | `yellow-goal/candidate-file-content/v1`. Same path/size/depth/`maxDocumentBytes` bounds as 3c, applied to the capture profile allowlist. Only `package-manifest-lockfile` may be used with `--from-capture`. |
| Checks | Installed `package-manifest-lockfile` argv/cwd. Bundle-stored bindings and candidate-supplied checkers are ignored. |
| Snapshot | Disposable `$TMPDIR` directory of selected bytes with recorded `100644`/`100755` filesystem modes applied before checks. Not a worktree of the source. Source HEAD/index/worktree canaries must survive. |

### Process interface

Additive verbs / options:

- `acceptance reproduce <bundle-dir> [--json]` — dispatch by `COMPLETE` schema (3c or 3e).
- `acceptance verify-candidate package-manifest-lockfile <candidate.json> --from-capture <bundle-dir> [--json] [--bundle-dir <dir>]`

`acceptance verify-candidate` without `--from-capture` remains the 3c `config-repair` path. `--from-capture` without that capture profile, or `config-repair` with `--from-capture`, is usage. Not a Protocol v1 capability. Does not load `run-command`.

| Property | Contract |
|---|---|
| stdout | Capture-schema JSON when the capture/overlay/reproduce-capture workflow finishes (affirmative **or** negative). 3c reproduce still emits `yellow-goal/candidate-offline-milestone/v1`. Empty on usage/I/O failure. |
| `--bundle-dir` | Still empty-directory / atomic `COMPLETE`. Refused inside the captured **source** worktree, per-worktree git dir, or **common** Git directory (`git rev-parse --git-common-dir`) for `capture-source` **and** `--from-capture` overlay persist. Overlay containment uses retained captured-source identity, not the destination checkout — an unrelated git checkout used only as evidence storage is allowed, including a chained overlay of authorized overlay replacement bytes that were never Git objects — dest-in-live-git then classifies dest using the original captured object set (unoverlayed stored blob contents), not overlay replacement bytes and not every live git checkout; dest inside the live captured source stays `USAGE_ERROR`. Overlay `--bundle-dir` requires a valid retained `source.identity` with **absolute** roots; missing, malformed, or relative identity paths are `BUNDLE_INVALID` and do not disable containment. Capture `--bundle-dir` is rechecked against the identity used for object reads before persist — a symlink `repo` retarget between the first resolve and `captureGitObjects` cannot persist into the second worktree. When `<repo>` is a non-bare checkout's git directory, resolve the associated worktree from that git directory rather than recording `worktree: null` — dest inside the checkout is still refused. Git UTF-8 object-read stdout strips only a terminating LF, not `.trim()` and not a trailing CR, so `--show-toplevel` of a checkout whose directory name ends in whitespace or CR keeps that pathname byte — capture and overlay `--bundle-dir` inside that checkout is `USAGE_ERROR`; honest capture into an unrelated empty dest still persists; dest inside a live captured checkout without trailing whitespace or CR stays `USAGE_ERROR`. When a stored source root no longer exists, keep the lexical containment result (do not treat every dest as contained). Overlay `--bundle-dir` in an unrelated empty dest after the captured checkout is gone persists. Replacing every retained identity field with well-formed absolute paths under an unrelated missing root does not disable containment of the still-live captured checkout: dest inside that checkout or its git directory is still refused (`USAGE_ERROR`) by binding dest against captured HEAD/index canaries **and** against captured blob objects still present in that checkout's object store. Retargeting stored `sourceIntegrity` canaries together with forged identity still refuses dest inside the live checkout. Overlay-all of every selected path then forging identity and canaries still refuses dest inside the live checkout: object-store probes use recorded `source.commit` or the full captured `gitSha` set, not overlay replacement bytes and not `shas.some(one blob)`. Rewriting `source.commit` and every captured `gitSha` to IDs absent from dest, together with forged identity and retargeted canaries, still refuses dest inside the live checkout: unless retained roots resolve as a coherent source identity **and** every stored blob content authenticates in that gitDir (`gitBlobSha1` via `cat-file -e`), dest inside a live git checkout is fail-closed (`USAGE_ERROR`). Overlay-all of every selected path leaves overlay replacement bytes that a coherent replacement identity does not contain, so that identity cannot skip that scan — dest inside the original captured checkout stays `USAGE_ERROR`; honest gone-source overlay into an unrelated empty dest still persists. Pointing only `source.identity.repoPath` at an existing unrelated path (for example `tmpdir`) while `gitDir` / `commonGitDir` / `worktree` stay missing does not skip that scan. An unrelated dest that shares only one captured blob (same `package.json` bytes, different lock/bin, different commit) is allowed; dest inside the live captured source stays `USAGE_ERROR`. Honest gone-source overlay into an unrelated empty dest still persists. Overlay persist rechecks dest immediately before write, canonicalizes symlink ancestors (nearest existing ancestor realpath plus remainder), and writes only to that verified directory — a `--bundle-dir` whose symlink ancestor is retargeted into the source after the earlier containment check cannot persist `COMPLETE` into the source. Capture persist rechecks dest immediately before write, canonicalizes symlink ancestors the same way, and writes only to that verified directory — a capture `--bundle-dir` whose symlink ancestor is retargeted into the source after the later containment check cannot persist `COMPLETE` into the source; honest capture into an unrelated empty dest still persists. Overlaying two selected paths (lock + bin) and leaving only `goal-gen/package.json` unoverlaid, then retargeting identity/commit/captured `gitSha`s/canaries to an unrelated checkout that shares only that blob, cannot skip dest-in-live-git: a singleton unoverlayed blob is a partial object-set match (`every` of one shared `package.json`) and dest inside the original captured checkout stays `USAGE_ERROR`; overlay-all of every selected path on the same replacement identity stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE`. Overlaying only the remaining selected path (bin) and leaving two unoverlayed blobs (json+lock) that a coherent replacement identity shares cannot skip dest-in-live-git: provenance authenticates every stored blob content in stored gitDir, not a shared-blob count, so dest inside the original captured checkout stays `USAGE_ERROR`; overlay-all of every selected path on the same replacement identity stays `USAGE_ERROR`; one-shared dest inside original stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE`. Persist opens dest with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and writes through that directory handle (`/proc/self/fd/<fd>`), not a replaceable pathname, after the final containment check — a dest ancestor renamed and replaced with a symlink into the source after dest readdir cannot persist `COMPLETE` into the source; honest empty dest persist still `COMPLETE`. Missing dest is created relative to an already-opened parent handle with those same flags — persist does not `existsSync` then pathname `mkdirSync`. Missing intermediate parents use the same recursive creation rule as 3c: walk the nearest existing ancestor and create each missing component under that handle rather than requiring the caller to pre-create the immediate parent. If dest does not exist and a dest ancestor is replaced with a symlink into the captured worktree or Git directory, destination creation must not leave an empty dest directory in the source (`USAGE_ERROR`, no `COMPLETE`); a created dest that is then rejected is removed via the opened root; honest empty dest persist still `COMPLETE`. Persist opens or creates every dest child (`blobs/`, nested dirs, leaves, `manifest.json`, `COMPLETE.tmp`) relative to directory handles with `O_NOFOLLOW` (leaves `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`) — a dest-child `blobs` symlink after emptiness/recheck is not followed into the captured source; honest empty dest persist still `COMPLETE` with a real `blobs/` directory. Reproduce opens `manifest.json` relative to an `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` bundle-dir handle with `O_RDONLY|O_NOFOLLOW` (nonblocking) and `fstat` of the opened inode — a same-size planted-digest symlink or FIFO swap of `manifest.json` cannot be consumed or hang; honest unswapped COMPLETE reproduce still `accepted: true`. Peek `COMPLETE` via a no-follow nonblocking descriptor and bounded-read the opened inode — a planted-schema symlink, FIFO, or 8MiB swap cannot hang or consume unchecked bytes. Selected blob leaf open uses `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and `fstat` of the opened inode — a FIFO swap of `blobs/goal-gen/package.json` cannot hang and is `BUNDLE_INCOMPLETE` (`selected blob is not a regular file`); honest unswapped COMPLETE reproduce still `accepted: true`. Gone-source `source.commit` that is not a full 40-hex object ID is `BUNDLE_INVALID` before the `gitDir` existence skip; honest gone-source still `accepted: true`. Reproduce holds the bundle-root directory descriptor across `COMPLETE`, `manifest.json`, and `blobs/` so a dest rename after the inner COMPLETE peek cannot mix that marker with a replacement overlay missing COMPLETE; honest unswapped COMPLETE reproduce still `accepted: true`. Persist success requires the caller `--bundle-dir` pathname to still be the opened dest after COMPLETE is written — dest renamed aside with an empty directory put back at the caller path cannot report success while COMPLETE is only at aside; failed persist rolls back COMPLETE/blobs/manifest through the dest fd so a dest inode moved into the captured source after dest open cannot leave those artifacts in the source; dest and dest children are held from write time; destFd vs caller dest uses lstat so dest-dir pathname is not reopened after dest children exist; destFd COMPLETE/manifest/blobs must still be the held inodes after the dest inode/COMPLETE check so dest children renamed into the captured worktree cannot report success with dest having only COMPLETE; missing destFd child names are restored from held descriptors then rolled back when destFd still is the caller path so stolen leftover is absent; dest-moved leftover still dest-fd rollback; chained overlay dest inside unrelated git still COMPLETE; honest empty dest persist still `COMPLETE`. Capture persist dest-symlink TOCTOU and overlay persist-TOCTOU still refuse. Selected and captured blob modes must be `100644` or `100755` during bundle validation; gone-source `profile-digest-mismatch` and unauthorized-overlay cannot persist `100600`. Canary dest-bind does not treat dest as captured source when stored or live index is `missing` (HEAD bytes plus an empty/missing index are not source identity); dest inside an unrelated bare that shares only symbolic HEAD bytes persists; dest inside the live captured source stays `USAGE_ERROR`. Untampered dest inside the live checkout stays `USAGE_ERROR`. If capture used a symlink `repoPath` that is later retargeted, overlay containment checks **retained stored roots and** any live re-resolved roots — dest inside the original captured worktree/git/common-dir still refuses. Overlay/reproduce write a **new** bundle directory, not the source. |
| Recorder | Still omitted on the capture schema. |
| Exit 0 | Bundle written. Includes valid negatives. |
| Exit 1 | Incomplete capture bundle, I/O, source mutation during overlay, or unexpected failure. |
| Exit 2 | Usage (wrong profile for `--from-capture`, empty `--from-capture`, unsafe candidate, missing capture bundle, `--from-capture` on 3c). |

### Trust boundary

- **Engine-owned:** profile, allowlist, argv, timeout, checkers, schema dispatch, blob-path allowlist inside the bundle.
- **Untrusted:** candidate document, persisted blob bytes, stored `decision.accepted`, stored bindings.
- Unauthorized extra candidate paths are `accepted: false` (`unauthorized-path`), not a launched overlay. Tampered extra `source.selected` paths (even with a matching blob) are `BUNDLE_INVALID` before snapshot; they cannot `accepted: true`. Selected blobs without a matching `source.captured` row (original mode + Git object identity) are `BUNDLE_INVALID` before snapshot; they cannot `accepted: true` while attributing bytes to `source.commit`. For a plain capture and for paths not listed in a recorded overlay, selected `sha256`/`byteLength` that do not match the captured row (or selected bytes that are not the git blob identified by `gitSha`) are `BUNDLE_INVALID` before snapshot — replacing `blobs/` and retargeting only `source.selected` cannot `accepted: true`. Duplicate `source.captured` paths are `BUNDLE_INVALID` before snapshot — last-row-wins cannot `accepted: true` attributing replaced bytes to `source.commit`. Every captured row must be a valid captured blob and the captured path set must match the selected path set before Git calls — null, malformed, or never-selected extra rows cannot `accepted: true` or persist COMPLETE. A coherent rewrite of blob bytes plus `source.selected` hash/length plus the matching `source.captured` hash/length/`gitSha` is `BUNDLE_INVALID` when retained identity still exists — captured rows cannot authorize foreign bytes for a still-claimed `source.commit`. Missing, null, or relative `source.identity` during persisted-bundle validation is `BUNDLE_INVALID`; it cannot skip that commit-bind. A symlink in any `blobs/` path component (leaf or intermediate directory) is `BUNDLE_INCOMPLETE` before snapshot; live host bytes reached through that symlink cannot `accepted: true`. Reproduce must not `accepted: true` when overlay-listed blob bytes are swapped for a same-sized external file after walk; blob reads descend through no-follow directory handles and `fstat` the opened leaf so path-based re-open cannot substitute those bytes (noswap of the forged selected hash stays `BUNDLE_INCOMPLETE`). Reproduce must not consume swapped `manifest.json` symlink or FIFO bytes or hang; it opens the manifest through a no-follow descriptor and `fstat`s the opened inode (honest unswapped COMPLETE reproduce still `accepted: true`). Reproduce must not hang on a FIFO `COMPLETE` or consume unchecked `COMPLETE` bytes (planted-schema symlink / 8MiB swap); peek opens `COMPLETE` through a no-follow nonblocking descriptor and bounded-reads the opened inode. Gone-source `source.commit` that is not a full 40-hex object ID is `BUNDLE_INVALID` before the `gitDir` existence skip; honest gone-source still `accepted: true`. Reproduce must not `accepted: true` mixing `COMPLETE` from dest A with extra-field overlay `manifest.json`/`blobs/` from an under-construction replacement B; the bundle-root directory descriptor stays open across marker, manifest, and blob reads (honest unswapped COMPLETE reproduce still `accepted: true`). Mutated stored bindings cannot change which checkers run. Stored overlay file text cannot authorize success on reproduce; checkers see hash-validated `blobs/` only. A persisted overlay that pairs an unauthorized path with a non-string or oversize value is `BUNDLE_INVALID` before `unauthorized-path`; string type and `maxFileBytes` are checked on every overlay entry first. Stored overlay keys that fail 3c path/depth safety (`../x`, over-depth) or exceed 3c `maxFiles` are `BUNDLE_INVALID`, not exit-0 `unauthorized-path`; `--from-capture` does not persist them. Overlay-all plus forged identity and retargeted canaries still refuses dest inside the live checkout. `--from-capture` and reproduce validate stored overlay values before treating overlay keys as authorization to waive selected-to-captured identity; a non-string or oversize overlay value cannot `accepted: true` an empty candidate over tampered selected bytes. A chained `--from-capture` whose candidate omits previously overlayed paths keeps those prior overlay keys (when they exist in stored blobs) so persist COMPLETE and relocated reproduce stay consistent; it does not rebuild from original captured bytes. Unauthorized persist merges prior overlay keys that still have stored blobs so relocated reproduce stays `unauthorized-path` (CS-13 is not weakened to `accepted: true` or dropped). Overlay `--bundle-dir` dest inside the still-live captured checkout stays refused when retained identity is replaced with well-formed absolute missing roots; dest is bound against captured HEAD/index canaries **and** original captured `gitSha` objects in that checkout, not overlay replacement bytes and not only stored roots/canaries that the same untrusted manifest can retarget independently. Overlay-all plus forged identity and retargeted canaries still refuses dest inside the live checkout.
- Overlay and reproduce do not checkout, fetch, or write the original source repository.

### Outcome table

| Case | Snapshot | Checks | Decision | Workflow exit |
|---|---|---|---|---|
| Moved capture bundle; temps deleted; fresh installed process | selected bytes restored | both rerun passed | `accepted: true` | 0 |
| Valid extra-field alternative overlay on captured base | overlay applied | both passed | `accepted: true` | 0 |
| Intentional lockfile/manifest metadata reject | overlay applied | `manifest-lock-agreement` failed | `accepted: false` | 0 |
| Extra unauthorized file in candidate | not launched as authorized overlay | omitted | `accepted: false` (`unauthorized-path`) | 0 |
| Tampered extra `source.selected` + blob outside installed `allowedPaths` | not launched | omitted | no stale success (`BUNDLE_INVALID`) | 1 |
| Selected blob without a matching `source.captured` row (mode + Git identity) | not launched | omitted | no stale success (`BUNDLE_INVALID`); overlay dest is not persisted | 1 |
| Intermediate `blobs/` path component is a directory symlink to a host dir | not launched | omitted | no stale success (`BUNDLE_INCOMPLETE`); overlay dest is not persisted | 1 |
| Duplicate `source.selected` paths or `selected.length > maxFiles` | not launched | omitted | no stale success (`BUNDLE_INVALID`) | 1 |
| Truncated `COMPLETE` (schema without trailing newline) | n/a | not launched | no stale success (`BUNDLE_INCOMPLETE`) | 1 |
| Persisted blob `stat.size` over installed `maxFileBytes` | n/a | not launched | no stale success (`BUNDLE_INCOMPLETE`) | 1 |
| `--from-capture` candidate file over 3c `maxFileBytes` | n/a | not launched | no bundle (`USAGE_ERROR`) | 2 |
| `--from-capture` on a valid 3c candidate-offline bundle | n/a | not launched | no overlay (`USAGE_ERROR`) | 2 |
| Empty `--from-capture=` (raw value empty before resolve) | n/a | not launched | no overlay (`USAGE_ERROR`) | 2 |
| Linked worktree `--bundle-dir` inside the common Git directory | n/a | not launched | no bundle (`USAGE_ERROR`) | 2 |
| Stored bindings mutated; installed profile unchanged | selected bytes restored | installed checkers rerun | decision from rerun, not stored bindings | 0 |
| Missing `COMPLETE` / missing blob file / sha256 mismatch | n/a | not launched | no stale success | 1 |
| 3c reproduce of a candidate-offline bundle | 3c path | 3c checkers | 3c contract | 0 |
| Tampered overlay text over hash-validated incoherent blobs | hash-validated blobs | rerun on blobs | `accepted: false` (or the blob-derived decision); overlay text ignored | 0 |
| Oversized overlay value (> 3c `maxFileBytes`) | n/a | not launched | no stale success (`BUNDLE_INVALID`) | 1 |
| Unauthorized overlay key paired with oversize or non-string value | n/a | not launched | no stale success (`BUNDLE_INVALID`); string type and `maxFileBytes` are checked before `unauthorized-path` | 1 |
| Stored overlay key `../x`, over-depth `a/b/c/d/e`, or more than 3c `maxFiles` | n/a | not launched | no stale success (`BUNDLE_INVALID`); path/count/depth are checked before `unauthorized-path`; `--from-capture` dest is not persisted; CLI `parseCandidateDocument` of the same document stays `USAGE_ERROR` | 1 / 2 |
| `manifest.json` opened-inode size over the derived cap | n/a | not launched | no stale success (`BUNDLE_INCOMPLETE`) | 1 |
| Overlay `--bundle-dir` inside source worktree or `.git` | n/a | not launched | no bundle (`USAGE_ERROR`) | 2 |
| Overlay `--bundle-dir` inside a linked worktree's common Git directory | n/a | not launched | no bundle (`USAGE_ERROR`) | 2 |
| Overlay `--bundle-dir` on `profile-digest-mismatch` | n/a | not launched | durable negative persisted with `stored.profile.digest`, `stored.profile.version`, and `stored.implementationRevision`; relocated reproduce stays `accepted: false` and keeps that provenance; non-empty dest is `USAGE_ERROR` | 0 / 2 |
| Overlay `--bundle-dir` inside an unrelated git checkout used as evidence storage | overlay applied | both passed | `accepted: true`; destination checkout is not the captured source | 0 |
| Chained overlay `--bundle-dir` inside an unrelated git checkout used as evidence storage (second overlay of authorized overlay bytes that were never Git objects) | overlay applied | both passed | `accepted: true`; dest-in-live-git classifies dest using the original captured object set (unoverlayed stored blob contents), not overlay replacement bytes and not every live git checkout; first overlay dest inside that evidence git still persists; dest inside the live captured source stays `USAGE_ERROR`; two-shared dest inside original stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE` | 0 / 2 |
| Overlay `--bundle-dir` inside an unrelated checkout that shares only one captured blob (same `package.json` bytes, different lock/bin, different commit) | overlay applied | both passed | `accepted: true`; dest is not inside the captured source; object-store fallback binds to recorded `source.commit` or the full captured `gitSha` set, not `shas.some(one blob)`; control with no shared blobs still persists; dest inside the live captured source stays `USAGE_ERROR` | 0 / 2 |
| Overlay `--bundle-dir` in an unrelated empty dest after the captured checkout is gone | overlay applied | both passed | `accepted: true`; lexical miss kept when stored roots do not exist | 0 |
| Overlay `--bundle-dir` inside the original captured source after a symlink `repoPath` is retargeted | n/a | not launched | no bundle (`USAGE_ERROR`); retained stored roots and live re-resolved roots both checked | 2 |
| Overlay `--bundle-dir` with missing, invalid, or relative retained `source.identity` | n/a | not launched | no bundle (`BUNDLE_INVALID`); dest inside orig worktree/`.git` is not persisted | 1 |
| Overlay `--bundle-dir` after every retained identity field is replaced with well-formed absolute paths under an unrelated missing root | n/a | not launched | no bundle (`USAGE_ERROR`); dest inside the live captured checkout / `.git` is not persisted; untampered control stays `USAGE_ERROR`; unrelated empty dest still persists | 2 / 0 |
| Overlay `--bundle-dir` after forged missing identity **and** retargeted `sourceIntegrity` canaries | n/a | not launched | no bundle (`USAGE_ERROR`); dest inside the live captured checkout / `.git` is not persisted; identity-only control stays `USAGE_ERROR`; unrelated empty dest still persists | 2 / 0 |
| Overlay `--bundle-dir` after overlay-all selected paths plus forged missing identity **and** retargeted canaries | n/a | not launched | no bundle (`USAGE_ERROR`); dest inside the live captured checkout / `.git` is not persisted; object-store probes use recorded `source.commit` or the full captured `gitSha` set (not overlay replacement bytes, not `shas.some(one blob)`); identity-only and plain combo controls stay `USAGE_ERROR`; unrelated empty dest still persists | 2 / 0 |
| Overlay `--bundle-dir` after overlay-all plus forged identity, retargeted canaries, **and** rewritten `source.commit` / captured `gitSha` (IDs absent from dest) | n/a | not launched | no bundle (`USAGE_ERROR`); dest inside the live captured checkout / `.git` is not persisted; containment fail-closes unless retained roots resolve as a coherent source identity and dest sits inside a live git checkout; unrelated empty dest still persists; gone-source honest moved-bundle reproduce still works | 2 / 0 |
| Overlay `--bundle-dir` after overlay-all plus rewritten object IDs, retargeted canaries, and partial identity (`repoPath` exists unrelated, `gitDir`/`commonGitDir`/`worktree` missing) | n/a | not launched | no bundle (`USAGE_ERROR`); dest inside the live captured checkout / `.git` is not persisted; one existing unrelated `repoPath` does not skip fail-closed; unrelated empty dest still persists | 2 / 0 |
| Overlay `--bundle-dir` after overlay-all plus a coherent replacement identity (unrelated live repo roots plus rewritten commit / captured `gitSha` / canaries) | n/a | not launched | no bundle (`USAGE_ERROR`); dest inside the original captured checkout / `.git` is not persisted; coherence cannot skip dest-in-live-git until every stored blob content authenticates in stored `gitDir`; overlay-all replacement bytes do not authenticate; unrelated empty dest still persists; gone-source honest moved-bundle reproduce still works | 2 / 0 |
| Overlay `--bundle-dir` after overlaying two selected paths (lock + bin) plus a coherent replacement identity that shares only the unoverlaid `package.json` blob | n/a | not launched | no bundle (`USAGE_ERROR`); dest inside the original captured checkout / `.git` is not persisted; a singleton unoverlayed blob cannot skip dest-in-live-git; overlay-all of every selected path on the same replacement identity stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE` | 2 / 0 |
| Overlay `--bundle-dir` after overlaying the remaining selected path (bin) plus a coherent replacement identity that shares two unoverlayed blobs (json+lock) | n/a | not launched | no bundle (`USAGE_ERROR`); dest inside the original captured checkout / `.git` is not persisted; provenance authenticates every stored blob content in stored gitDir, not a shared-blob count; overlay-all of every selected path on the same replacement identity stays `USAGE_ERROR`; one-shared dest inside original stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE` | 2 / 0 |
| Overlay persist `--bundle-dir` whose symlink ancestor is retargeted into the source after the earlier containment check and before write | n/a | not launched | no bundle (`USAGE_ERROR`); dest is rechecked and canonicalized immediately before persist; writes are anchored to that verified directory; `COMPLETE` is not written into the source | 2 |
| Capture persist `--bundle-dir` whose symlink ancestor is retargeted into the source after the later containment check and before write | n/a | not launched | no bundle (`USAGE_ERROR`); dest is rechecked and canonicalized immediately before persist; writes are anchored to that verified directory; `COMPLETE` is not written into the source; honest capture into an unrelated empty dest still persists | 2 / 0 |
| Overlay persist `--bundle-dir` whose dest ancestor is replaced with a symlink into the source after dest readdir (after canonicalize and checker snapshot) | n/a | not launched | no bundle into the source; persist opens dest with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and writes through that directory handle, not the replaceable pathname; `COMPLETE` is not written into the source; honest empty dest persist still `COMPLETE`; earlier symlink-ancestor persist TOCTOU still refuses | 2 / 0 |
| Overlay persist `--bundle-dir` missing dest whose ancestor is replaced with a symlink into the source (or `.git`) between dest open and parent mkdir | n/a | not launched | no leftover empty dest directory in the source; dest is created relative to an already-opened parent handle, not pathname `mkdirSync` after `existsSync`; `USAGE_ERROR` dest is not persisted `COMPLETE`; honest empty dest persist still `COMPLETE` | 2 / 0 |
| Capture or overlay `--bundle-dir` whose immediate parent does not exist (`work/new/evidence` with `new` missing) | overlay applied / captured | both passed | persist `COMPLETE`; missing parents are created by walking the nearest existing ancestor and mkdir of each missing component relative to an opened parent handle, same recursive rule as 3c; leftover source-dir mkdir-follow still refuses; dest inside source stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE` | 0 / 2 |
| Overlay persist `--bundle-dir` after emptiness/recheck whose `blobs` child is replaced with a symlink into the captured worktree | n/a | not launched | no write into the source; persist opens or creates every dest child (including `blobs/`, nested dirs, leaves, `manifest.json`, and `COMPLETE.tmp`) relative to directory handles with `O_NOFOLLOW` / `O_CREAT|O_EXCL|O_NOFOLLOW`; dest-child symlink is not followed into captured `package.json`; honest empty dest persist still `COMPLETE` with a real `blobs/` directory | 2 / 0 |
| Overlay reproduce after walk/`lstat` of overlaid `goal-gen/package.json` swapped for same-sized external bytes (untrusted selected hash retargeted; path listed in `source.overlay`) | n/a | not launched | no stale success (`BUNDLE_INCOMPLETE`); reproduce cannot `accepted: true` for bytes durable `blobs/` never contained; blob reads descend through no-follow directory handles and `fstat` the opened leaf; noswap of that forged selected hash stays `BUNDLE_INCOMPLETE` | 1 |
| Overlay reproduce after `lstat` of `manifest.json` swapped for a same-size planted-digest symlink or FIFO | n/a | not launched | no stale success (`BUNDLE_INCOMPLETE`); reproduce opens `manifest.json` via a no-follow descriptor and `fstat` of the opened inode — swapped planted-digest bytes are not consumed and a FIFO does not hang; honest unswapped COMPLETE reproduce still `accepted: true` | 1 |
| Overlay reproduce after `lstat` of `COMPLETE` swapped for a planted-schema symlink, FIFO, or 8MiB regular file | n/a | not launched | no stale success (`BUNDLE_INCOMPLETE`); peek opens `COMPLETE` via a no-follow nonblocking descriptor and bounded-reads the opened inode — FIFO does not hang and unchecked oversized bytes are not consumed; honest unswapped COMPLETE reproduce still `accepted: true` | 1 |
| Overlay reproduce after a selected blob (`blobs/goal-gen/package.json`) is swapped for a FIFO | n/a | not launched | no stale success (`BUNDLE_INCOMPLETE`); selected blob leaf open uses `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and `fstat` of the opened inode — FIFO does not hang and is not a regular file; honest unswapped COMPLETE reproduce still `accepted: true` | 1 |
| Gone-source reproduce after `source.commit` is replaced with `not-a-commit` | n/a | not launched | no stale success (`BUNDLE_INVALID`); 40-hex validation runs before the `gitDir` existence skip; live-source tamper of the same invalid commit stays `BUNDLE_INVALID`; honest gone-source still `accepted: true` | 1 |
| Reproduce after inner `COMPLETE` peek while dest is renamed aside and replaced with extra-field overlay missing `COMPLETE` | n/a | not launched | no mixed success; bundle-root directory descriptor stays open across `COMPLETE`/`manifest.json`/`blobs/` so replacement overlay bytes are not accepted; honest unswapped COMPLETE reproduce still `accepted: true`; replacement without swap is `BUNDLE_INCOMPLETE` | 1 / 0 |
| Capture or overlay persist after dest is renamed aside and replaced with an empty directory at the caller `--bundle-dir` | n/a | not launched | no success; persist requires the caller pathname to still be the opened dest after COMPLETE so COMPLETE is not only at aside; failed persist rolls back COMPLETE/blobs/manifest through the dest fd; honest empty dest persist still `COMPLETE` | 2 / 0 |
| Capture or overlay persist after dest is moved into the captured source after dest is opened (`opened.created === false`) | n/a | not launched | no success (`USAGE_ERROR`); persist artifacts written through the dest fd are rolled back so COMPLETE/blobs/manifest are not left in the source; caller dest path has no COMPLETE; honest empty dest persist still `COMPLETE` | 2 / 0 |
| Capture or overlay persist after dest children (`manifest.json`/`blobs/`) are stolen into the captured source before the dest inode/COMPLETE check | n/a | not launched | no success (`USAGE_ERROR`); dest-dir pathname is not reopened after dest children exist; destFd children vs held inodes refuse leftover COMPLETE-only dest; dest has no COMPLETE/manifest/blobs leftover; stolen leftover in source is absent; dest-moved leftover still dest-fd rollback; chained overlay dest inside unrelated git still COMPLETE; honest empty dest persist still `COMPLETE` | 2 / 0 |
| Capture or overlay `--bundle-dir` inside a checkout whose directory name ends in whitespace | n/a | not launched | no bundle (`USAGE_ERROR`); `--show-toplevel` keeps trailing whitespace (only Git's terminating LF is stripped); `COMPLETE` is not written into the source; honest capture into an unrelated empty dest still persists; dest inside a live captured checkout without trailing whitespace stays `USAGE_ERROR` | 2 / 0 |
| Capture or overlay `--bundle-dir` inside a checkout whose directory name ends in CR | n/a | not launched | no bundle (`USAGE_ERROR`); `--show-toplevel` keeps the CR pathname byte (only Git's terminating LF is stripped, not a trailing CR); `COMPLETE` is not written into the source; honest capture into an unrelated empty dest still persists; dest inside a live captured checkout without trailing CR stays `USAGE_ERROR` | 2 / 0 |
| Gone-source overlay persist with selected and captured modes `100600` (`profile-digest-mismatch` and unauthorized-overlay) | n/a | not launched | no stale success (`BUNDLE_INVALID`); `unsupported captured blob mode: 100600`; dest is not persisted; honest gone-source overlay with original `100644`/`100755` still persists | 1 / 0 |
| Overlay `--bundle-dir` inside an unrelated bare repo that shares only symbolic HEAD bytes and a missing index | overlay applied | both passed | `accepted: true`; canary dest-bind requires a present index; dest inside the live captured source stays `USAGE_ERROR`; unrelated empty dest still persists | 0 / 2 |
| Overlay-null blob replace with selected-hash retarget (`source.overlay` null; captured `sha256`/`gitSha` unchanged) | n/a | not launched | `BUNDLE_INVALID`; cannot `accepted: true` attributing foreign bytes to `source.commit`; overlay dest is not persisted | 1 |
| Coherent overlay-null blob + selected + captured-row rewrite (`source.commit` unchanged) | n/a | not launched | no stale success (`BUNDLE_INVALID`); captured row cannot authorize foreign bytes for the still-claimed `source.commit`; overlay dest is not persisted; control without the captured-row update stays `BUNDLE_INVALID` captured-identity | 1 |
| Duplicate `source.captured` row for an allowlisted path plus blob replace and selected-hash retarget | n/a | not launched | no stale success (`BUNDLE_INVALID`); last row cannot authorize replaced bytes on original `source.commit`; overlay dest is not persisted; control without the duplicate row stays `BUNDLE_INVALID` captured-identity | 1 |
| Coherent overlay-null blob + selected + captured-row rewrite after delete/null/relative `source.identity` (`source.commit` unchanged; original repo remains) | n/a | not launched | no stale success (`BUNDLE_INVALID`); missing/invalid identity cannot skip commit-bind; `reproduce` cannot `accepted: true` attributing replaced bytes to original `source.commit`; keep-identity control of the same replace stays `BUNDLE_INVALID` `captured blob does not match source.commit` | 1 |
| Extra, null, or malformed `source.captured` rows (never-selected `goal-gen/README.md`) | n/a | not launched | no stale success (`BUNDLE_INVALID`); captured path set must match selected set before Git calls; overlay dest is not persisted; untampered control still `accepted: true` | 1 |
| Capture `--bundle-dir` inside a worktree whose symlink `repo` is retargeted between identity resolve and object reads | n/a | not launched | no bundle (`USAGE_ERROR`); dest inside the captured identity is not persisted | 2 |
| Capture `--bundle-dir` inside a checkout when `<repo>` is that checkout's `.git` directory | n/a | not launched | no bundle (`USAGE_ERROR`); dest is not persisted (associated worktree is resolved, not `null`) | 2 |
| Captured `100755` selected path (`goal-gen/bin/goal-gen.mjs`) | selected bytes restored with filesystem mode `0o755` before checks | both rerun passed | `accepted: true`; `source.selected` still `100755`; snapshot path is not `0o644` | 0 |
| `--from-capture` on a persisted overlay whose values are non-string or oversize, with selected-hash retarget and empty `files: {}` | n/a | not launched | no stale success (`BUNDLE_INVALID`); overlay keys do not waive selected-to-captured identity; dest is not persisted | 1 |
| Chained `--from-capture` whose candidate keeps only `package.json` after a two-path overlay (extra-field manifest + commented bin) | overlay applied; prior overlay keys merged | both passed | `accepted: true`; overlay keys stay both paths; selected bin sha256 stays overlay; captured bin stays original; relocated reproduce `accepted: true` | 0 |
| Unauthorized-only `--from-capture` of an authorized overlay dest (`extra.txt` only) | not launched as authorized overlay | omitted | `accepted: false` (`unauthorized-path`); overlay keys keep prior overlay paths that still have stored blobs plus extra.txt; relocated reproduce stays `unauthorized-path`, not `BUNDLE_INVALID` captured-identity; plain-capture unauthorized control stays `unauthorized-path` | 0 |
| Empty `files: {}` `--from-capture` of a valid overlay dest | overlay applied; prior overlay keys kept | both passed | `accepted: true`; relocated reproduce `accepted: true` | 0 |
| Empty `files: {}` `--from-capture` of a plain capture (`source.overlay` null) | no overlay files | both passed | `accepted: true`; overlay stays `{}` / null-equivalent; relocated reproduce `accepted: true` | 0 |
| Chained `--from-capture` that restates both prior overlay paths | overlay applied | both passed | `accepted: true`; relocated reproduce `accepted: true` | 0 |
| Installed profile digest drift (`allowedPaths` / `maxFiles` / `maxFileBytes`) vs a historical capture | n/a | not launched | `profile-digest-mismatch`; new blob policy is not applied before the digest compare; hard allocation caps remain; mismatch output keeps `stored.profile.digest`, `stored.profile.version`, and `stored.implementationRevision` | 0 |

### Requirement-to-test mapping

| ID | Requirement | Test |
|---|---|---|
| CS-10 | Capture `--bundle-dir` persists selected bytes/modes/identities; moved bundle `acceptance reproduce` from a fresh process reruns trusted checks | `committed-source.test.ts` + `install-smoke.sh` |
| CS-11 | FILE-CONTENT overlay onto captured base: valid extra-field alternative; chained `--from-capture` that omits a previously overlayed path keeps those prior overlay keys (paths in stored blobs) and relocated-reproduce `accepted: true`; empty `files: {}` from an overlay dest keeps prior keys; empty `files: {}` from a plain capture stays `{}`; restating both prior paths still `accepted: true`; intentional metadata reject | `committed-source.test.ts` |
| CS-12 | Unauthorized extra candidate files, tampered extra `source.selected` paths, selected blobs without a matching `source.captured` row, overlay-null blob replace with selected-hash retarget, duplicate `source.captured` paths (last row cannot authorize replaced bytes on original `source.commit`), coherent overlay-null blob + selected + captured-row rewrite (captured row cannot authorize foreign bytes for still-claimed `source.commit`), missing/null/relative `source.identity` skipping that commit-bind (`reproduce` cannot `accepted: true` attributing replaced bytes to original `source.commit`), extra/null/malformed `source.captured` rows (captured path set must match selected set before Git calls), `--from-capture` on a persisted overlay whose values are non-string or oversize (keys do not waive selected-to-captured identity; empty `files: {}` is `BUNDLE_INVALID`), chained `--from-capture` persist that drops prior overlay keys for retained overlay blob bytes (relocated reproduce would `BUNDLE_INVALID` captured-identity), duplicate selected paths, `selected.length > maxFiles`, truncated `COMPLETE`, oversized persisted blobs, a symlink in any `blobs/` path component (including an intermediate directory), and mutated stored bindings cannot authorize success; a persisted overlay that pairs an unauthorized key with a non-string or oversize value is `BUNDLE_INVALID` (string type and `maxFileBytes` before `unauthorized-path`); stored overlay keys that fail 3c path/depth safety or exceed 3c `maxFiles` are `BUNDLE_INVALID`, not `unauthorized-path`; `--bundle-dir` through a symlink ancestor into the source is refused; `--from-capture` uses 3c candidate file byte bounds and a 3c COMPLETE is usage; linked-worktree `--bundle-dir` inside the common Git directory is refused; replacing retained identity with well-formed absolute missing roots does not persist dest inside the live captured checkout; forging those roots together with retargeted `sourceIntegrity` canaries still does not persist dest inside the live captured checkout (bind dest against original captured `gitSha` objects still in that checkout, not overlay replacement bytes and not only identity and canaries the same untrusted manifest can retarget independently); overlay-all of every selected path plus forged identity and canaries still does not persist dest inside the live checkout (object-store fallback binds to recorded `source.commit` or the full captured `gitSha` set, not `shas.some(one blob)`); overlay-all plus forged identity, retargeted canaries, and rewritten `source.commit` / captured `gitSha` still does not persist dest inside the live checkout (fail-closed unless retained roots resolve as a coherent source identity **and** every stored blob content authenticates in that gitDir; overlay-all cannot skip that scan; one existing unrelated `repoPath` does not skip that scan); overlay `--bundle-dir` after overlay-all plus a coherent replacement identity still does not persist dest inside the original captured checkout; overlay `--bundle-dir` after overlaying two selected paths (lock + bin) plus a coherent replacement identity that shares only the unoverlaid `package.json` blob still does not persist dest inside the original captured checkout (a singleton unoverlayed blob cannot skip dest-in-live-git; overlay-all on the same replacement identity stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE`); overlay `--bundle-dir` after overlaying the remaining selected path (bin) plus a coherent replacement identity that shares two unoverlayed blobs (json+lock) still does not persist dest inside the original captured checkout (provenance authenticates every stored blob content in stored gitDir, not a shared-blob count; overlay-all on the same replacement identity stays `USAGE_ERROR`; one-shared dest inside original stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE`); persist opens dest with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and writes through that directory handle so a dest ancestor replaced with a symlink into the source after dest readdir cannot persist `COMPLETE` into the source (honest empty dest persist still `COMPLETE`; capture persist dest-symlink TOCTOU and overlay persist-TOCTOU still refuse); overlay persist rechecks and canonicalizes dest immediately before write so a symlink ancestor retargeted into the source cannot persist `COMPLETE` into the source; capture persist rechecks and canonicalizes dest immediately before write so a dest symlink ancestor retargeted into the source after the later containment check cannot persist `COMPLETE` into the source (honest capture into an unrelated empty dest still persists); Git `--show-toplevel` pathnames strip only a terminating LF so dest inside a checkout whose directory name ends in whitespace or CR is refused (`USAGE_ERROR`; the CR pathname byte is kept; honest empty dest still persists; dest inside a live captured checkout without trailing whitespace or CR stays `USAGE_ERROR`); selected and captured blob modes other than `100644`/`100755` are `BUNDLE_INVALID` before persist; overlay `--bundle-dir` inside an unrelated bare that shares only HEAD bytes and a missing index is allowed and dest inside the live captured source stays `USAGE_ERROR`; overlay `--bundle-dir` inside an unrelated checkout that shares only one captured blob is allowed and dest inside the live captured source stays `USAGE_ERROR`; unauthorized persist of extra.txt from an overlay dest must keep prior overlay keys that still have stored blobs so relocated reproduce stays `unauthorized-path` (CS-13 is not weakened); missing dest is created relative to an already-opened parent handle so a dest-ancestor symlink swap cannot leave an empty dest directory in the source (`USAGE_ERROR`, no `COMPLETE`; honest empty dest persist still `COMPLETE`); missing dest whose immediate parent does not exist is created by walking the nearest existing ancestor and mkdir of each missing component relative to that handle (same recursive rule as 3c; dest inside source stays `USAGE_ERROR`); persist opens or creates every dest child (`blobs/`, nested dirs, leaves, `manifest.json`, `COMPLETE.tmp`) relative to directory handles with `O_NOFOLLOW` so a dest-child `blobs` symlink after emptiness/recheck is not followed into captured `package.json` (honest empty dest persist still `COMPLETE` with a real `blobs/` directory); overlay-listed same-sized external blob bytes swapped after walk cannot `accepted: true` (blob reads descend through no-follow directory handles and `fstat` the opened leaf; noswap stays `BUNDLE_INCOMPLETE`); a same-size planted-digest symlink or FIFO swap of `manifest.json` cannot be consumed or hang (reproduce opens the manifest through a no-follow descriptor and `fstat`s the opened inode; honest unswapped COMPLETE reproduce still `accepted: true`); a planted-schema symlink, FIFO, or 8MiB swap of `COMPLETE` cannot hang or consume unchecked bytes (peek opens `COMPLETE` through a no-follow nonblocking descriptor and bounded-reads the opened inode; honest unswapped COMPLETE reproduce still `accepted: true`); a FIFO swap of a selected blob (`blobs/goal-gen/package.json`) cannot hang (selected blob leaf open uses `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and `fstat` of the opened inode; `BUNDLE_INCOMPLETE`; honest unswapped COMPLETE reproduce still `accepted: true`); gone-source `source.commit` that is not a full 40-hex object ID is `BUNDLE_INVALID` before the `gitDir` existence skip (honest gone-source still `accepted: true`); dest renamed after the inner COMPLETE peek cannot mix that marker with a replacement extra-field overlay missing COMPLETE (bundle-root directory descriptor stays open across `COMPLETE`/`manifest.json`/`blobs/`; honest unswapped COMPLETE reproduce still `accepted: true`); persist success requires the caller `--bundle-dir` pathname to still be the opened dest after COMPLETE is written (dest renamed aside with an empty directory at the caller path cannot report success while COMPLETE is only at aside; failed persist rolls back COMPLETE/blobs/manifest through the dest fd so a dest inode moved into the captured source after dest open cannot leave those artifacts in the source; dest and dest children are held from write time; destFd vs caller dest uses lstat so dest-dir pathname is not reopened after dest children exist; destFd COMPLETE/manifest/blobs must still be the held inodes after the dest inode/COMPLETE check so dest children renamed into the captured worktree cannot report success with dest having only COMPLETE; missing destFd child names are restored from held descriptors then rolled back when destFd still is the caller path so stolen leftover is absent; dest-moved leftover still dest-fd rollback; chained overlay dest inside unrelated git still COMPLETE; honest empty dest persist still `COMPLETE`); chained overlay `--bundle-dir` inside an unrelated git checkout used as evidence storage persists COMPLETE (dest-in-live-git classifies dest using the original captured object set, not overlay replacement bytes and not every live git checkout; dest inside the live captured source stays `USAGE_ERROR`; two-shared dest inside original stays `USAGE_ERROR`); source checkout unmodified | same |
| CS-13 | Unauthorized-overlay persist stays `accepted: false` (`unauthorized-path`) on `acceptance reproduce` after relocation; unauthorized persist of extra.txt from an overlay dest keeps prior overlay keys that still have stored blobs so replay stays `unauthorized-path`, not `BUNDLE_INVALID` captured-identity; stored `decision.accepted` is not re-verification | `committed-source.test.ts` |
| CS-14 | Reproduce snapshots hash-validated `blobs/` only; overlay text cannot authorize success; overlay values over 3c `maxFileBytes` and oversized `manifest.json` fail closed; a persisted overlay that pairs an unauthorized key with a non-string or oversize value is `BUNDLE_INVALID` before `unauthorized-path`; stored overlay keys that fail 3c path/depth safety (`../x`, over-depth) or exceed 3c `maxFiles` are `BUNDLE_INVALID` before `unauthorized-path`; overlay `--bundle-dir` inside the source checkout or common Git directory is refused; overlay `--bundle-dir` inside an unrelated git checkout used as evidence storage is allowed; overlay `--bundle-dir` in an unrelated empty dest after the captured checkout is gone persists (keep lexical containment when stored roots do not exist); overlay `--bundle-dir` after retained identity is replaced with well-formed absolute missing roots still refuses dest inside the live captured checkout (bind dest against captured HEAD/index canaries and original captured `gitSha` objects still in that checkout, not overlay replacement bytes); overlay `--bundle-dir` after forged missing identity and retargeted `sourceIntegrity` canaries still refuses dest inside the live captured checkout; overlay `--bundle-dir` after overlay-all selected paths plus forged identity and retargeted canaries still refuses dest inside the live captured checkout (object-store fallback binds to recorded `source.commit` or the full captured `gitSha` set, not overlay replacement bytes and not `shas.some(one blob)`); overlay `--bundle-dir` after overlay-all plus forged identity, retargeted canaries, and rewritten `source.commit` / captured `gitSha` still refuses dest inside the live captured checkout (fail-closed unless retained roots resolve as a coherent source identity **and** every stored blob content authenticates in that gitDir; overlay-all cannot skip that scan; one existing unrelated `repoPath` does not skip that scan; unrelated empty dest still persists); overlay `--bundle-dir` after overlay-all plus a coherent replacement identity still refuses dest inside the original captured checkout; overlay `--bundle-dir` after overlaying two selected paths (lock + bin) plus a coherent replacement identity that shares only the unoverlaid `package.json` blob still does not persist dest inside the original captured checkout (a singleton unoverlayed blob cannot skip dest-in-live-git; overlay-all on the same replacement identity stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE`); overlay `--bundle-dir` after overlaying the remaining selected path (bin) plus a coherent replacement identity that shares two unoverlayed blobs (json+lock) still does not persist dest inside the original captured checkout (provenance authenticates every stored blob content in stored gitDir, not a shared-blob count; overlay-all on the same replacement identity stays `USAGE_ERROR`; one-shared dest inside original stays `USAGE_ERROR`; honest empty dest persist still `COMPLETE`); persist opens dest with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and writes through that directory handle so a dest ancestor replaced with a symlink into the source after dest readdir cannot persist `COMPLETE` into the source (honest empty dest persist still `COMPLETE`; capture persist dest-symlink TOCTOU and overlay persist-TOCTOU still refuse); missing dest is created relative to an already-opened parent handle so a dest-ancestor symlink swap cannot leave an empty dest directory in the source (`USAGE_ERROR`, no `COMPLETE`; honest empty dest persist still `COMPLETE`); missing dest whose immediate parent does not exist is created by walking the nearest existing ancestor and mkdir of each missing component relative to that handle (same recursive rule as 3c; dest inside source stays `USAGE_ERROR`); persist opens or creates every dest child (`blobs/`, nested dirs, leaves, `manifest.json`, `COMPLETE.tmp`) relative to directory handles with `O_NOFOLLOW` so a dest-child `blobs` symlink after emptiness/recheck is not followed into captured `package.json` (honest empty dest persist still `COMPLETE` with a real `blobs/` directory); overlay persist rechecks and canonicalizes dest immediately before write so a symlink ancestor retargeted into the source cannot persist `COMPLETE` into the source; capture persist rechecks and canonicalizes dest immediately before write so a dest symlink ancestor retargeted into the source after the later containment check cannot persist `COMPLETE` into the source (honest capture into an unrelated empty dest still persists); Git `--show-toplevel` pathnames strip only a terminating LF so dest inside a checkout whose directory name ends in whitespace or CR is refused (`USAGE_ERROR`; the CR pathname byte is kept; honest empty dest still persists; dest inside a live captured checkout without trailing whitespace or CR stays `USAGE_ERROR`); selected and captured blob modes other than `100644`/`100755` are `BUNDLE_INVALID` before persist (gone-source `profile-digest-mismatch` and unauthorized-overlay cannot persist `100600`); overlay `--bundle-dir` inside an unrelated bare that shares only HEAD bytes and a missing index is allowed (dest inside the live captured source stays `USAGE_ERROR`); overlay `--bundle-dir` inside an unrelated checkout that shares only one captured blob is allowed (dest inside the live captured source stays `USAGE_ERROR`); overlay `--bundle-dir` after a retargeted symlink `repoPath` still refuses dest inside the original captured source (retained and live roots); overlay `--bundle-dir` requires valid retained `source.identity` with absolute roots (`BUNDLE_INVALID` if missing/malformed/relative); persisted-bundle validation also rejects missing/null/relative `source.identity` (`reproduce` cannot skip commit-bind); extra/null/malformed `source.captured` rows are `BUNDLE_INVALID` before Git calls (captured path set must match selected); capture `--bundle-dir` is rechecked against the identity used for object reads before persist; empty `--from-capture=` is usage before resolve; overlay `--bundle-dir` on `profile-digest-mismatch` persists the negative with `stored.profile.digest`, `stored.profile.version`, and `stored.implementationRevision` and still validates an empty destination; installed profile digest drift is `profile-digest-mismatch` before new allowlist/`maxFiles`/`maxFileBytes` policy, with stable hard allocation caps; mismatch reproduce stdout keeps `stored.profile.digest`, `stored.profile.version`, and `stored.implementationRevision`; selected blobs without a matching `source.captured` row (mode + Git identity) are `BUNDLE_INVALID` before snapshot; for a plain capture and for paths not listed in a recorded overlay, selected bytes that do not match the captured row's original hash/length and Git object identity are `BUNDLE_INVALID` before snapshot; duplicate `source.captured` paths are `BUNDLE_INVALID` before snapshot; stored overlay values are validated (string type, 3c `maxFileBytes`, path/depth safety, and 3c `maxFiles`) before overlay keys waive that identity check, so `--from-capture` of a tampered overlay plus empty `files: {}` is `BUNDLE_INVALID`; chained `--from-capture` that omits a previously overlayed path merges prior overlay files whose keys exist in stored blobs with the new candidate so persist+reproduce stay consistent (empty `files: {}` from an overlay dest keeps prior keys; empty `files: {}` from a plain capture stays `{}`; unauthorized persist also merges those prior overlay keys so relocated reproduce stays `unauthorized-path`, not `BUNDLE_INVALID` captured-identity); a symlink in any `blobs/` path component (including an intermediate directory) is `BUNDLE_INCOMPLETE` before snapshot; blob reads descend through no-follow directory handles and `fstat` the opened leaf so overlay-listed same-sized external bytes swapped after walk cannot `accepted: true` (noswap of that forged selected hash stays `BUNDLE_INCOMPLETE`); reproduce opens `manifest.json` through a no-follow descriptor and `fstat`s the opened inode so a same-size planted-digest symlink or FIFO swap cannot be consumed or hang (honest unswapped COMPLETE reproduce still `accepted: true`); peek opens `COMPLETE` through a no-follow nonblocking descriptor and bounded-reads the opened inode so a planted-schema symlink, FIFO, or 8MiB swap cannot hang or consume unchecked bytes (honest unswapped COMPLETE reproduce still `accepted: true`); selected blob leaf open uses `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` so a FIFO swap of `blobs/goal-gen/package.json` cannot hang (`BUNDLE_INCOMPLETE`; honest unswapped COMPLETE reproduce still `accepted: true`); gone-source `source.commit` that is not a full 40-hex object ID is `BUNDLE_INVALID` before the `gitDir` existence skip (only live `ls-tree` binding depends on `gitDir` existing; honest gone-source still `accepted: true`); dest renamed after the inner COMPLETE peek cannot mix that marker with a replacement extra-field overlay missing COMPLETE (bundle-root directory descriptor stays open across `COMPLETE`/`manifest.json`/`blobs/`; honest unswapped COMPLETE reproduce still `accepted: true`); persist success requires the caller `--bundle-dir` pathname to still be the opened dest after COMPLETE is written (dest renamed aside with an empty directory at the caller path cannot report success while COMPLETE is only at aside; failed persist rolls back COMPLETE/blobs/manifest through the dest fd so a dest inode moved into the captured source after dest open cannot leave those artifacts in the source; dest and dest children are held from write time; destFd vs caller dest uses lstat so dest-dir pathname is not reopened after dest children exist; destFd COMPLETE/manifest/blobs must still be the held inodes after the dest inode/COMPLETE check so dest children renamed into the captured worktree cannot report success with dest having only COMPLETE; missing destFd child names are restored from held descriptors then rolled back when destFd still is the caller path so stolen leftover is absent; dest-moved leftover still dest-fd rollback; chained overlay dest inside unrelated git still COMPLETE; honest empty dest persist still `COMPLETE`); overlay `--bundle-dir` inside an unrelated git checkout used as evidence storage is allowed, including chained overlay of authorized overlay replacement bytes (dest-in-live-git classifies dest using the original captured object set, not overlay replacement bytes and not every live git checkout; dest inside the live captured source stays `USAGE_ERROR`; two-shared dest inside original stays `USAGE_ERROR`); checker snapshots apply recorded `100644`/`100755` filesystem modes before checks (assert the snapshot path mode, not only Buffer bytes); capture `--bundle-dir` inside a checkout when `<repo>` is that checkout's `.git` directory is refused (associated worktree is resolved, not recorded as `null`) | same |

## Failure / blocked cases (documentation and publication)

| Case | Result |
|---|---|
| ADR-0018 number already used on refreshed main | Block; pick next free MADR number |
| PRD edit rewrites M1/M2/M3 or protocol advertised ops | Block; out of scope |
| Worker includes `.cursor/` or CE files | Block |
| Stack provider not READY and mutation is requested | Block; do not raw-push |
| Reviewer write permissions broadened silently to substitute for verification | Block |
| Treating host `readonly: true` as sufficient independent verification | Block |

## Four `.cursor` files

Not required for this milestone. Host bootstrap is a separate candidate after a content review.
