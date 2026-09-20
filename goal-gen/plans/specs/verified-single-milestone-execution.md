# Verified single-milestone execution — Yellow Harness outcome

Status: proposed design; documentation slice complete (#34, merged on `36eeeae`).
Date: 2026-09-19. Owner: Yellow Goal (Yellow Harness coordination).
Decision: [ADR-0018](../../docs/decisions/0018-verified-single-milestone-execution.md).
Engine bases: documentation parent `09bcd16cd25ec249e3248d3ce7dcb4536a0d348e` (#34);
current `main` `36eeeaef016b53529b6819f9db9ba5a4728f3397` (post-merge).

## Phasing

Four layers — do not conflate them:

| Layer | What it is | Status |
|---|---|---|
| 1. Eventual product outcome | One approved milestone, one repo, one immutable **base** revision, one bounded implementation worker → independently verified patch (against a recorded **candidate** commit or tree snapshot) or evidence-backed blocker. No automatic merge or deployment. | Named; not executable yet |
| 2. Documentation increment | PRD FR-14–FR-17, proposed ADR-0018, this spec (VS-01–VS-07). | **Complete** (#34) |
| 3. First code increment | Fixture-only acceptance-evidence recording through an existing engine process seam; disposable git fixture; deterministic local checks only. | **Implemented** (yellow-goal #36; unmerged). Git-free JSON recorder only. |
| 3b. Observed fixture verification | Engine-owned fixed profiles, disposable-repo observer, packed `acceptance record` subprocess, separate fixture-scoped decision. | This increment. Not live target-bound execution. |
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
| stdout | One JSON bundle `yellow-goal/observed-fixture-verification/v1` when the workflow finishes (affirmative **or** negative decision). Empty on usage/I/O failure. |
| stderr | Structured `{"error":{"code","message"}}` on usage (exit 2) or I/O/unexpected (exit 1) only. Empty when a bundle is written. |
| Recorder | Child process: `goal-gen acceptance record <fixture.json> --json` via `bin/goal-gen.mjs`. The workflow does **not** import the recorder. |
| Exit 0 | Bundle written. Includes valid negative records and `accepted: false`. |
| Exit 1 | No bundle: I/O or unexpected infrastructure failure. |
| Exit 2 | Usage (wrong arity, unknown profile/variant). |

There is **no** `--fixture`, `observed:true`, or imported-JSON authorization route.

### Trust boundary

- **Engine-owned:** profile, argv, timeout, approved overlay, check implementations.
- **Candidate-writable:** disposable working tree only.
- **Observer** measures trees (temporary index, isolated object store, `git add -A --force`), keeps the real index clean, rejects escaping symlinks / empty directories / nested `.git` / dirty submodules **before** measurement, and re-verifies those after every launched check.
- **Recorder** stays git-free and command-free. The child is given a PATH trap so a regression that shells out to `git` or the fixture `command` string fails the sentinel.
- **Decider** reads the observer's provenance plus the recorder subprocess result. Hand-authored all-passed JSON may be valid **recorder** input and still cannot produce an affirmative decision from this verb.
- Observation faults (precondition violation, measurement abort, spawn failure) are workflow blockers: `accepted: false`, recorder not invoked, **no** invented recorder fields.

### Outcome table

| Case | Observer | Recorder subprocess | Decision | Workflow exit |
|---|---|---|---|---|
| Failing baseline (required check nonzero, no leftover mutation) | real failed row | record written, aggregate `failed`, exit 0 | `accepted: false` | 0 |
| Approved/correct candidate, all required checks pass, no leftover mutation, overlay matches | real passed rows | record `passed`, exit 0 | `accepted: true` | 0 |
| Incorrect candidate (real check fails) | real failed row | record `failed`, exit 0 | `accepted: false` | 0 |
| Timeout / signal | launched, `blocked` + `signal`, no `exitStatus` even if the child later exits | record `blocked`, exit 0 | `accepted: false` | 0 |
| Leftover mutation (changed tree, empty dir, nested `.git`, dirty submodule) | `blocked` + `candidate mutated by check` | record `blocked`, exit 0 | `accepted: false` | 0 |
| Observation fault (escaping symlink, empty dir / nested `.git` / dirty submodule **before** start, measurement abort) | no honest fixture | **not invoked** | `accepted: false` | 0 |
| Hand-authored all-passed JSON | n/a | valid `acceptance record` input | cannot substitute for this verb | n/a |
| Unknown profile/variant or imported JSON path | n/a | not invoked | no bundle | 2 |

### Requirement-to-test mapping

| ID | Requirement | Test |
|---|---|---|
| OF-01 | Engine-owned profile; candidate cannot redefine required checks | `observed-fixture.test.ts` |
| OF-02 | Disposable repo only; argument-vector spawn; no shell interpolation | same |
| OF-03 | Trees via temporary-index + isolated object store + `--force` | same |
| OF-04 | Empty-dir / nested `.git` / escaping symlink / submodule re-verifies | same |
| OF-05 | Timeout stays `blocked` even if the child later exits | same |
| OF-06 | Packed/installed `acceptance record` is a subprocess | `observed-fixture.test.ts` + `install-smoke.sh` |
| OF-07 | Failing baseline, correct candidate, incorrect candidate from real observations | same |
| OF-08 | Valid negative record is not acceptance | same |
| OF-09 | Hand-authored all-passed JSON records but cannot authorize this workflow | same |
| OF-10 | Observation fault does not invent recorder fields | same |
| OF-11 | Compiler cold path does not load observer; observer does not load `run-command` | isolation tests |

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
