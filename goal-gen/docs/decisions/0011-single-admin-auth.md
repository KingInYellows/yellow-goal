---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0011. Single-admin auth on a local Proxmox LXC/VM

## Context and problem statement
The web UI is effectively a remote-code-execution surface — it runs agents with the user's subscriptions and repo access. It's a local, single-user tool.

## Decision
Run on a dedicated **Proxmox LXC or VM**, single-user behind a **simple admin login** (session), reachable only on the user's own network or via **Tailscale/VPN** — **no LAN-wide or public exposure.** Secrets/CLI credentials stay on the host.

## Alternatives considered
- **LAN behind a shared token** — the token is the only barrier to RCE on your subscriptions.
- **Full multi-user auth/roles now** — overkill for a single operator.

## Consequences
- 👍 Minimal attack surface; simple to operate.
- 👎 Not multi-user by design; remote access requires Tailscale/VPN.

## Confirmation
PRD §11; `api.md` auth section.

## Links
- PRD §11/§14, `.claude/specs/api.md`.
