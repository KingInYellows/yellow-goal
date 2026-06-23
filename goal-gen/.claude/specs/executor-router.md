# Spec — Executor Router & Adapters

**Component:** `backend/src/executors/` (+ optional MCP server `backend/src/mcp/`). **Depends on:** host-installed CLIs. **Consumed by:** orchestrator.
**Principle:** one uniform interface over every backend; capture **real** results (the ground-truth oracle the LLM lacks).

## Interface
```ts
interface RunContext { runId: string; worktreePath: string; signal: AbortSignal; budgetUsdRemaining: number; }
interface Executor {
  kind: ExecutorKind;
  run(action: Action, ctx: RunContext): Promise<AgentRun>;
}
interface AgentRun {
  id: string; planId: string; actionId: string; executor: ExecutorKind;
  startedAt: string; endedAt?: string;
  status: 'running'|'succeeded'|'failed'|'cancelled';
  stdout?: string; stderr?: string; exitCode?: number; diffRef?: string;
  tokens?: number; costUsd?: number;
}
```

## Adapters (verify exact flags against current vendor docs before shipping)
**v1 ships the `claude-code` adapter only; `codex`, `antigravity`, `shell`, and `mcp` adapters are M2+.**
| kind | invocation | auth |
|---|---|---|
| `claude-code` | `claude -p "<prompt>" --output-format json [--permission-mode …]`; parse `total_cost_usd` | Max/Team subscription (host login); `ANTHROPIC_API_KEY` fallback |
| `codex` | `codex exec "<prompt>"`; `codex cloud exec --attempts N` for best-of-N | `codex login` (ChatGPT plan); API key fallback |
| `antigravity` | `agy -p "<prompt>" --output-format <fmt>` | `agy` login (Google AI Pro/Ultra). Target `agy`, **not** retired `gemini` CLI |
| `shell` | `child_process` exec | n/a |
| `mcp` | MCP tool call | per server |

## Routing
- **v1: Claude Code only** — every action runs on the `claude-code` adapter regardless of `action.executor`.
- **M2:** honor `action.executor` (from the extractor) by default; allow operator override (reassign); optional auto-selection policy (by task type / cost / availability), pluggable and off by default.

## Behavior
- Spawn the CLI as a subprocess in `ctx.worktreePath`; pipe the prompt; stream stdout/stderr to the realtime channel; capture exit code.
- Honor `ctx.signal` (kill) by sending SIGTERM, then SIGKILL after a grace period.
- Parse tokens/cost where the tool emits them (e.g., Claude Code `--output-format json`); record on `AgentRun`.
- Never echo secrets; redact env from logs.

## Error / edge cases
- CLI not installed / not logged in → fail fast with an actionable message (don't hang).
- Rate-limit / auth error → surface; optionally fall back to API key if configured.
- Non-zero exit → `status:'failed'` with stderr captured (orchestrator decides retry/replan).
- Timeout → kill subprocess, mark failed.

## Acceptance criteria
- **v1:** the `claude-code` adapter executes a trivial action end-to-end on the host and returns a populated `AgentRun` (exit code + `total_cost_usd`). **M2:** Codex + Antigravity adapters do the same.
- Kill terminates the subprocess promptly.
- Adapters are swappable without touching orchestrator/planner code.

## Out of scope
Deciding *which* actions exist (extractor), ordering (planner), replanning policy (orchestrator).
