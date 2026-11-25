#!/usr/bin/env python3
"""Run from a trusted yellow-goal checkout with the installed yellow-review gate."""
import argparse
from datetime import datetime
import json
import os
import re
from pathlib import Path
import subprocess
import sys

REPO = "KingInYellows/yellow-goal"
OWNER = "KingInYellow18"
LABEL = "merge-approved"


def installed_gate():
    result = subprocess.run(["claude", "plugin", "list", "--json"], capture_output=True,
                            text=True, timeout=30, check=True)
    cache = (Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
             / "plugins/cache/yellow-plugins/yellow-review").resolve(strict=True)
    for plugin in json.loads(result.stdout):
        if plugin["id"] != "yellow-review@yellow-plugins" or plugin["enabled"] is not True:
            continue
        if plugin["scope"] in ("project", "local") and Path(plugin["projectPath"]).resolve() != Path.cwd():
            continue
        install = Path(plugin["installPath"]).resolve(strict=True)
        if install.parent != cache:
            continue
        gate = (install / "skills/pr-review-workflow/scripts/check-merge-ready").resolve(strict=True)
        if gate.is_relative_to(install) and gate.is_file():
            return gate
    raise ValueError("enabled yellow-review installation missing from the plugin cache")


def gh(*args):
    result = subprocess.run(["gh", "api", *args], capture_output=True, text=True,
                            timeout=60, check=True)
    return json.loads(result.stdout)


def timestamp(value):
    instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if instant.tzinfo is None:
        raise ValueError("timestamp missing timezone")
    return instant


def label_matches_head(activity, pages, current, expected_head):
    if current["head"]["sha"] != expected_head:
        return False
    if LABEL not in [label["name"] for label in current["labels"]]:
        return False
    # The latest transition of this exact ref includes pushes back to a SHA
    # checked before. A commit date or its first check cannot establish that.
    ref = "refs/heads/" + current["head"]["ref"]
    if (len(activity) != 1 or activity[0]["ref"] != ref
            or activity[0]["after"] != expected_head):
        raise ValueError("latest head transition unavailable")
    arrival = timestamp(activity[0]["timestamp"])
    # Preserve API order for simultaneous events. An unreadable event fails closed.
    changes = [(timestamp(e["created_at"]), e) for page in pages for e in page
               if e["event"] in ("labeled", "unlabeled") and e["label"]["name"] == LABEL]
    if not changes:
        return False
    at, last = sorted(changes, key=lambda change: change[0])[-1]
    return (at > arrival and last["event"] == "labeled"
            and last["actor"]["type"] == "User"
            and last["actor"]["login"].casefold() == OWNER.casefold()
            and last["performed_via_github_app"] is None)


def merge_ready(shared_gate, number):
    report = subprocess.run(["/bin/sh", str(shared_gate), REPO, str(number)], stdout=subprocess.PIPE,
                            text=True, timeout=420)
    gate = json.loads(report.stdout)
    if report.returncode or gate["verdict"] != "ready":
        print(json.dumps(gate))
        return False
    tier, head = gate["approval"]["tier"], gate["head"]
    if tier not in ("low", "medium", "high") or gate["approval"]["policy"] != "default_branch":
        raise ValueError("risk tier or policy unavailable")
    if tier == "low":
        print(f"Low risk at {head}: no owner label required.")
        return True
    # The shared checker also accepts an approving review and prefers it over a
    # label. Inspect the label independently even when that review exists.
    endpoint = f"repos/{REPO}/pulls/{number}"
    source = gh(endpoint)["head"]
    if source["sha"] != head:
        raise ValueError("head changed during readiness check")
    source_repo = source["repo"]["full_name"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source_repo):
        raise ValueError("invalid head repository")
    pages = gh("--paginate", "--slurp", f"repos/{REPO}/issues/{number}/events?per_page=100")
    activity = gh("--method", "GET", f"repos/{source_repo}/activity",
                  "-f", "ref=refs/heads/" + source["ref"], "-f", "direction=desc", "-F", "per_page=1")
    current = gh(endpoint)
    if (current["head"]["repo"]["id"] == source["repo"]["id"]
            and current["head"]["ref"] == source["ref"]
            and label_matches_head(activity, pages, current, head)):
        print(f"{tier} risk at {head}: verified manual {LABEL} from {OWNER}.")
        return True
    print(f"{tier} risk at {head}: {OWNER} must add {LABEL} by hand after the current head.")
    return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("number", type=int)
    args = parser.parse_args()
    if args.number < 1:
        parser.error("supply a positive PR number")
    try:
        ready = merge_ready(installed_gate(), args.number)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, IndexError, TypeError, AttributeError) as err:
        sys.exit(f"Merge readiness unknown ({type(err).__name__}).")
    if ready:
        print("Ready to merge.")
    sys.exit(0 if ready else 1)
