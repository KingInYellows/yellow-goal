"""Fixture-only integration of the installed gate response and GitHub API reads."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("merge_ready", Path(__file__).with_name("check-merge-ready.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

HEAD = "1" * 40
PUSH = "2026-11-23T00:01:00Z"
LATER = "2026-11-23T00:02:00Z"


class MergeApprovalTest(unittest.TestCase):
    def setUp(self):
        self.report = {"verdict": "ready", "head": HEAD, "approval": {
            "tier": "medium", "policy": "default_branch", "humanApproval": {"via": "review"}}}
        self.activity = [{"after": HEAD, "ref": "refs/heads/topic", "timestamp": PUSH}]
        self.event = {"event": "labeled", "label": {"name": gate.LABEL}, "actor": {
            "login": gate.OWNER, "type": "User"}, "created_at": LATER, "performed_via_github_app": None}
        self.pages = [[self.event]]
        self.current = {"head": {"sha": HEAD, "ref": "topic",
                                 "repo": {"id": 42, "full_name": "KingInYellows/yellow-goal"}},
                        "labels": [{"name": gate.LABEL}]}

    def check(self, *, expect_network=True, shared_rc=0):
        result = subprocess.CompletedProcess([], shared_rc, stdout=json.dumps(self.report))
        source = deepcopy(self.current)
        source["head"]["sha"] = HEAD
        data = [source, self.pages, self.activity, self.current]
        with patch.object(gate.subprocess, "run", return_value=result), patch.object(gate, "gh", side_effect=data) as gh:
            ready = gate.merge_ready(Path("/installed/check-merge-ready"), 1)
        self.assertEqual(gh.call_count, 4 if expect_network else 0)
        return ready

    def test_low_without_label(self):
        self.report["approval"]["tier"] = "low"
        self.assertTrue(self.check(expect_network=False))

    def test_low_tier_requires_default_branch_policy(self):
        self.report["approval"].update(tier="low", policy="none")
        with self.assertRaises(ValueError):
            self.check(expect_network=False)

    def test_missing_label_even_with_review(self):
        self.current["labels"] = []
        self.assertFalse(self.check())

    def test_owner_label_after_head_for_medium_and_high(self):
        for tier in ("medium", "high"):
            with self.subTest(tier=tier):
                self.report["approval"]["tier"] = tier
                self.assertTrue(self.check())

    def test_wrong_actor(self):
        self.event["actor"]["login"] = "another-user"
        self.assertFalse(self.check())

    def test_app_reapplied_owner_label_on_later_page(self):
        added = deepcopy(self.event)
        added["performed_via_github_app"] = {"id": 1}
        self.pages.append([added])
        self.assertFalse(self.check())

    def test_later_push_invalidates_label_even_if_sha_was_checked_previously(self):
        self.activity[0]["timestamp"] = "2026-11-23T00:03:00Z"
        self.assertFalse(self.check())

    def test_same_second_cannot_establish_order(self):
        self.activity[0]["timestamp"] = LATER
        self.assertFalse(self.check())

    def test_incomplete_or_mismatched_activity_fails_closed(self):
        for activity in ([], [{**self.activity[0], "after": "2" * 40}],
                         [{**self.activity[0], "ref": "refs/heads/other"}]):
            with self.subTest(activity=activity), self.assertRaises(ValueError):
                self.activity = activity
                self.check()

    def test_final_head_changed(self):
        self.current["head"]["sha"] = "2" * 40
        self.assertFalse(self.check())

    def test_other_blocker_survives_valid_label(self):
        self.report["verdict"] = "blocked"
        self.assertFalse(self.check(expect_network=False, shared_rc=1))


if __name__ == "__main__":
    unittest.main()
