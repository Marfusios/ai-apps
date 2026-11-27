"""Tests for the Podman and Claude command lines and for reading the CLI's transcript."""

import dataclasses
import unittest
from pathlib import Path

from factory import pod

REQUEST = {
    "stage": "fix_issue", "skill": "factory-fix-issue", "branch": "factory/fix-7", "base_sha": "a" * 40,
    "model": "opus", "permission_mode": "auto", "max_turns": 300,
}
MOUNTS = pod.Mounts(Path("/w/checkout"), Path("/w/job"), Path("/w/out"))
IMAGE = "localhost/factory-agent:1"
NO_FACTS = pod.Facts(False, None, "", None, "", False)


def after_image(argv: list[str]) -> list[str]:
    return argv[argv.index(IMAGE) + 1:]


class ArgvTests(unittest.TestCase):
    def test_claude_argv_is_the_documented_command(self):
        self.assertEqual(pod.claude_argv(REQUEST), [
            "claude", "-p", "/factory-fix-issue", "--permission-mode", "auto", "--model", "opus", "--max-turns", "300",
            "--output-format", "stream-json", "--verbose",
        ])

    def test_agent_argv_is_confined_and_carries_no_secret(self):
        argv = pod.agent_argv(REQUEST, MOUNTS, IMAGE, "factory-x")
        for flag in ("--cap-drop=all", "--security-opt=no-new-privileges", "--userns=keep-id:uid=1000,gid=1000",
                     "--network=slirp4netns", "--pull=never", "--rm", "--log-driver=none"):
            self.assertIn(flag, argv)
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN", argv)
        self.assertFalse(any(a.startswith("CLAUDE_CODE_OAUTH_TOKEN=") for a in argv))
        self.assertEqual(after_image(argv)[:3], ["claude", "-p", "/factory-fix-issue"])

    def test_agent_argv_is_exactly_the_documented_command(self):
        self.assertEqual(pod.agent_argv(REQUEST, MOUNTS, IMAGE, "factory-x"), [
            "podman", "run", "--rm", "--pull=never", "--name", "factory-x", "--log-driver=none",
            "--userns=keep-id:uid=1000,gid=1000", "--cap-drop=all", "--security-opt=no-new-privileges",
            "--network=slirp4netns",
            "-v", f"{MOUNTS.checkout}:/workspace:rw", "-v", f"{MOUNTS.job}:/factory/job:ro",
            "-v", f"{MOUNTS.out}:/factory/out:rw", "-w", "/workspace",
            "--env", "FACTORY_RUN=1", "--env", "FACTORY_STAGE=fix_issue", "--env", "FACTORY_JOB_DIR=/factory/job",
            "--env", "FACTORY_RESULT_PATH=/factory/out/result.json", "--env", f"FACTORY_BASE_SHA={'a' * 40}",
            "--env", "DISABLE_AUTOUPDATER=1", "--env", "CLAUDE_CODE_OAUTH_TOKEN",
            IMAGE, *pod.claude_argv(REQUEST),
        ])

    def test_bundle_argv_is_exactly_the_documented_command_with_no_network_and_no_token(self):
        self.assertEqual(pod.bundle_argv(REQUEST, MOUNTS, IMAGE, "factory-x-bundle"), [
            "podman", "run", "--rm", "--pull=never", "--name", "factory-x-bundle", "--log-driver=none",
            "--userns=keep-id:uid=1000,gid=1000", "--cap-drop=all", "--security-opt=no-new-privileges",
            "--network=none",
            "-v", f"{MOUNTS.checkout}:/workspace:ro", "-v", f"{MOUNTS.out}:/factory/out:rw", "-w", "/workspace",
            IMAGE, "git", "-C", "/workspace", "bundle", "create", "/factory/out/commits.bundle",
            f"{'a' * 40}..refs/heads/factory/fix-7",
        ])


class TranscriptTests(unittest.TestCase):
    def test_read_transcript(self):
        lines = ['{"type":"system","subtype":"init","model":"claude-opus-5-5"}', "not json",
                 '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1795863600}}',
                 '{"type":"result","subtype":"error_during_execution","num_turns":41}']
        self.assertEqual(pod.read_transcript(lines),
                         pod.Facts(True, 1795863600, "error_during_execution", 41, "claude-opus-5-5", True))

    def test_an_allowed_rate_limit_event_with_overage_rejected_is_not_a_limit(self):
        line = ('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1795863600,'
                '"overageStatus":"rejected"}}')
        self.assertEqual(pod.read_transcript([line]), NO_FACTS)

    def test_an_empty_transcript_has_no_facts(self):
        self.assertEqual(pod.read_transcript([]), NO_FACTS)

    def test_the_last_result_wins(self):
        lines = ['{"type":"result","subtype":"success","num_turns":3}',
                 '{"type":"result","subtype":"error_max_turns","num_turns":300}']
        facts = pod.read_transcript(lines)
        self.assertEqual((facts.subtype, facts.turns), ("error_max_turns", 300))

    def test_a_rejected_event_without_an_integer_reset_is_limited_without_a_time(self):
        for reset in ('"soon"', "1.5", "true", "null"):
            line = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":%s}}' % reset
            self.assertEqual(pod.read_transcript([line]), dataclasses.replace(NO_FACTS, limited=True), reset)

    def test_wrongly_shaped_objects_are_ignored(self):
        lines = ["[]", "3", "null", '{"type":"rate_limit_event","rate_limit_info":[]}',
                 '{"type":"rate_limit_event"}', '{"type":"result","subtype":5,"num_turns":"x"}',
                 '{"type":"system","subtype":"other","model":"m"}']
        self.assertEqual(pod.read_transcript(lines), NO_FACTS)

    def test_an_init_line_means_the_cli_started_whatever_it_says_of_the_model(self):
        for line in ('{"type":"system","subtype":"init"}', '{"type":"system","subtype":"init","model":7}'):
            with self.subTest(line=line):
                facts = pod.read_transcript([line])
                self.assertEqual(facts, dataclasses.replace(NO_FACTS, started=True))

    def test_a_bool_is_not_a_turn_count(self):
        self.assertIsNone(pod.read_transcript(['{"type":"result","subtype":"success","num_turns":true}']).turns)


if __name__ == "__main__":
    unittest.main()
