Fixture: this file's own NAME contains shell metacharacters (`$(...)`), not just its content.
Used to assert that a tracked path with metacharacters round-trips correctly through
`lsFiles`/`lsTree` (arg-array-safe, git's `-z` null-delimited output) and is treated as inert data,
never as something to execute or shell-expand.
