"""Local synthetic contract checks only; never create real approvals or game output."""

from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("game_agent_team", PROJECT / "scripts" / "check-game-agent-team.py")
team = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(team)


def source_binding():
    return {"snapshotDigest": "a" * 64, "policyVersion": "teen-v1", "proposals": [{
        "id": "fixture_proposal", "revision": 1, "bodyHash": "b" * 64, "policyVersion": "teen-v1",
        "safetyReviewId": "fixture_review", "safetyRevision": 1, "developmentBriefHash": "c" * 64,
    }]}


def handoff():
    return {
        "schemaVersion": 1, "runId": "fixture_run", "role": "scenario_designer", "status": "complete",
        "input": {"snapshotPath": "input/snapshot.json", "inputGatePath": "input/step02_input-gate.json",
                  "isolationPath": "input/isolation.json", "upstreamHandoffs": ["output/step01_intake.json"]},
        "sourceBinding": source_binding(),
        "artifacts": [{"path": "output/step02_scenario.md", "sha256": "d" * 64, "bytes": 128}],
        "checks": [{"name": name, "result": "pass", "evidencePath": "output/step02_checks.json"}
                   for name in ("source_binding", "path_scope")],
        "blockers": [],
    }


def manifest():
    return {
        "schemaVersion": 1, "runId": "fixture_run", "policyVersion": "teen-v1", "snapshotDigest": "a" * 64,
        "assets": [{"id": "portrait", "path": "assets/portrait.png", "mediaType": "image/png",
                    "sha256": "e" * 64, "bytes": 128, "dimensions": {"width": 360, "height": 640},
                    "license": {"id": "LicenseRef-Fixture", "evidencePath": "input/licenses/fixture.txt",
                                "attributionRequired": False},
                    "provenance": {"kind": "codex_original", "sourceRef": "input/provenance/fixture.json"},
                    "ownerRole": "art_director", "revision": 1}],
    }


class TeamConfigTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="yourgame-agent-team-")
        self.root = Path(self.temporary.name)
        self.assertEqual(self.root.resolve().parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith("yourgame-agent-team-"))
        self.addCleanup(self.temporary.cleanup)
        (self.root / ".codex" / "agents").mkdir(parents=True)
        shutil.copyfile(PROJECT / ".codex" / "config.toml", self.root / ".codex" / "config.toml")
        for role in team.ROLES:
            file = f"{role}.toml"
            shutil.copyfile(PROJECT / ".codex" / "agents" / file, self.root / ".codex" / "agents" / file)
        (self.root / "docs").mkdir()
        (self.root / "docs" / "game-agent-workflow.md").write_text("fixture", encoding="utf-8")
        (self.root / "blueprint-game-development.md").write_text("fixture", encoding="utf-8")

    def test_actual_team_parses_without_claiming_execution_or_isolation(self):
        result = team.validate_team(PROJECT)
        self.assertEqual(result["customAgents"], 5)
        self.assertEqual(result["maxSpawnedThreads"], 3)
        for key in ("roleExecutionVerified", "isolationVerified", "releaseAllowed"):
            self.assertIs(result[key], False)

    def test_slot_limit_and_unrequested_settings_are_rejected(self):
        for text in ('[agents]\nmax_concurrent_threads_per_session=4\n',
                     '[agents]\nmax_concurrent_threads_per_session=true\n',
                     '[agents]\nmax_concurrent_threads_per_session=3\ndefault_subagent_model="fixed"\n'):
            with self.subTest(text=text):
                (self.root / ".codex" / "config.toml").write_text(text, encoding="utf-8")
                with self.assertRaisesRegex(team.ContractError, "INVALID_TEAM_CONFIG"):
                    team.validate_team(self.root)

    def test_model_permission_and_provider_overrides_are_rejected(self):
        file = self.root / ".codex" / "agents" / "scenario_designer.toml"
        original = file.read_text(encoding="utf-8")
        for text in ('model="fixed"', 'sandbox_mode="danger-full-access"',
                     '[mcp_servers.extra]\nurl="https://example.invalid"'):
            with self.subTest(text=text):
                file.write_text(original + "\n" + text + "\n", encoding="utf-8")
                with self.assertRaisesRegex(team.ContractError, "INVALID_AGENT_CONFIG"):
                    team.validate_team(self.root)

    def test_missing_agent_and_mismatched_name_are_rejected(self):
        file = self.root / ".codex" / "agents" / "asset_manager.toml"
        original = file.read_text(encoding="utf-8")
        file.write_text(original.replace('name = "asset_manager"', 'name = "other_role"', 1), encoding="utf-8")
        with self.assertRaisesRegex(team.ContractError, "INVALID_AGENT_CONFIG"):
            team.validate_team(self.root)
        file.unlink()
        with self.assertRaisesRegex(team.ContractError, "CONFIG_PARSE_FAILED"):
            team.validate_team(self.root)

    def test_invalid_toml_is_redacted_in_cli(self):
        marker = "private_marker_never_echo"
        (self.root / ".codex" / "config.toml").write_text(f'[agents]\n{marker}="unterminated', encoding="utf-8")
        output = io.StringIO()
        with redirect_stdout(output):
            code = team.main([str(self.root)])
        self.assertEqual(code, 1)
        self.assertNotIn(marker, output.getvalue())
        self.assertNotIn(str(self.root), output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["code"], "TEAM_STRUCTURE_INVALID")


class HandoffTests(unittest.TestCase):
    def test_complete_structure_is_not_evidence_authentication(self):
        result = team.validate_handoff(handoff(), expected_run_id="fixture_run", expected_source_binding=source_binding())
        self.assertTrue(result["structureValid"])
        self.assertFalse(result["releaseAllowed"])
        self.assertFalse(result["evidenceAuthenticityVerified"])

    def test_blocked_without_input_does_not_need_fake_approval(self):
        value = handoff()
        value.update(status="blocked", sourceBinding=None, artifacts=[], checks=[], blockers=["ISOLATION_UNAVAILABLE"])
        value["input"] = {"snapshotPath": None, "inputGatePath": None, "isolationPath": None, "upstreamHandoffs": []}
        self.assertTrue(team.validate_handoff(value)["structureValid"])

    def test_cross_run_and_stale_binding_are_rejected(self):
        with self.assertRaisesRegex(team.ContractError, "HANDOFF_RUN_MISMATCH"):
            team.validate_handoff(handoff(), expected_run_id="another_run")
        expected = source_binding()
        expected["proposals"][0]["safetyRevision"] = 2
        with self.assertRaisesRegex(team.ContractError, "HANDOFF_SOURCE_MISMATCH"):
            team.validate_handoff(handoff(), expected_source_binding=expected)

    def test_all_binding_fields_are_required_and_policy_is_current(self):
        for key in source_binding()["proposals"][0]:
            with self.subTest(key=key):
                value = handoff()
                del value["sourceBinding"]["proposals"][0][key]
                with self.assertRaisesRegex(team.ContractError, "INVALID_SOURCE_BINDING"):
                    team.validate_handoff(value)
        for change in ("duplicate", "old_policy", "boolean_revision", "raw_body"):
            value = handoff()
            binding = value["sourceBinding"]
            if change == "duplicate":
                binding["proposals"].append(deepcopy(binding["proposals"][0]))
            elif change == "old_policy":
                binding["policyVersion"] = "old-policy"
            elif change == "boolean_revision":
                binding["proposals"][0]["revision"] = True
            else:
                binding["proposals"][0]["body"] = "fixture untrusted content"
            with self.subTest(change=change), self.assertRaisesRegex(team.ContractError, "INVALID_SOURCE_BINDING"):
                team.validate_handoff(value)

    def test_role_scope_traversal_private_paths_and_urls_are_rejected(self):
        for path in ("output/step03_assets/other.png", "output/step02_assets/../private.txt",
                     "output/step02_assets/.env", "C:/private.json", "https://example.invalid/file.json",
                     "output/step02_assets/NUL.json", "output/step02_assets/source%2fsecret.json"):
            value = handoff()
            value["artifacts"][0]["path"] = path
            with self.subTest(path=path), self.assertRaisesRegex(team.ContractError, "INVALID_HANDOFF_ARTIFACT"):
                team.validate_handoff(value)

    def test_case_alias_and_artifact_size_limit_are_rejected(self):
        value = handoff()
        duplicate = deepcopy(value["artifacts"][0])
        duplicate["path"] = "output/step02_scenario.MD"
        value["artifacts"].append(duplicate)
        with self.assertRaisesRegex(team.ContractError, "INVALID_HANDOFF_ARTIFACT"):
            team.validate_handoff(value)
        value = handoff()
        value["artifacts"][0]["bytes"] = team.MAX_BYTES + 1
        with self.assertRaisesRegex(team.ContractError, "INVALID_HANDOFF_ARTIFACT"):
            team.validate_handoff(value)

    def test_fail_not_run_missing_isolation_and_blocker_cannot_be_complete(self):
        for change in ("fail", "not_run", "missing_isolation", "blocker"):
            value = handoff()
            if change in ("fail", "not_run"):
                value["checks"][0]["result"] = change
            elif change == "missing_isolation":
                value["input"]["isolationPath"] = None
            else:
                value["blockers"] = ["RELEASE_REVIEW_UNAVAILABLE"]
            with self.subTest(change=change), self.assertRaisesRegex(team.ContractError, "INCOMPLETE_HANDOFF"):
                team.validate_handoff(value)

    def test_release_flags_and_duplicate_checks_are_rejected(self):
        value = handoff()
        value["releaseAllowed"] = True
        with self.assertRaisesRegex(team.ContractError, "INVALID_HANDOFF"):
            team.validate_handoff(value)
        value = handoff()
        value["checks"].append(deepcopy(value["checks"][0]))
        with self.assertRaisesRegex(team.ContractError, "INVALID_HANDOFF_CHECK"):
            team.validate_handoff(value)


class AssetManifestTests(unittest.TestCase):
    def test_manifest_and_empty_manifest_are_structural_only(self):
        for assets in (manifest()["assets"], []):
            value = manifest()
            value["assets"] = assets
            result = team.validate_asset_manifest(value, expected_run_id="fixture_run", expected_snapshot_digest="a" * 64)
            self.assertTrue(result["structureValid"])
            self.assertFalse(result["releaseAllowed"])
            self.assertFalse(result["artifactBytesVerified"])
            self.assertFalse(result["licenseRightsVerified"])

    def test_manifest_must_match_run_snapshot_and_policy(self):
        with self.assertRaisesRegex(team.ContractError, "ASSET_RUN_MISMATCH"):
            team.validate_asset_manifest(manifest(), expected_run_id="different_run")
        with self.assertRaisesRegex(team.ContractError, "ASSET_SOURCE_MISMATCH"):
            team.validate_asset_manifest(manifest(), expected_snapshot_digest="f" * 64)
        value = manifest()
        value["policyVersion"] = "old-policy"
        with self.assertRaisesRegex(team.ContractError, "INVALID_ASSET_MANIFEST"):
            team.validate_asset_manifest(value)

    def test_missing_license_provenance_hash_owner_and_revision_fail(self):
        for key in ("license", "provenance", "sha256", "dimensions", "ownerRole", "revision"):
            value = manifest()
            del value["assets"][0][key]
            with self.subTest(key=key), self.assertRaisesRegex(team.ContractError, "INVALID_ASSET"):
                team.validate_asset_manifest(value)
        for field, invalid in (("sha256", "not-a-hash"), ("ownerRole", "operator"), ("revision", True)):
            value = manifest()
            value["assets"][0][field] = invalid
            with self.subTest(field=field), self.assertRaisesRegex(team.ContractError, "INVALID_ASSET"):
                team.validate_asset_manifest(value)

    def test_external_provenance_paths_and_fabricated_approval_fields_fail(self):
        value = manifest()
        value["assets"][0]["license"]["evidencePath"] = "https://example.invalid/license.txt"
        with self.assertRaisesRegex(team.ContractError, "INVALID_ASSET_LICENSE"):
            team.validate_asset_manifest(value)
        value = manifest()
        value["assets"][0]["provenance"]["approved"] = True
        with self.assertRaisesRegex(team.ContractError, "INVALID_ASSET_PROVENANCE"):
            team.validate_asset_manifest(value)

    def test_duplicate_case_paths_and_invalid_dimensions_fail(self):
        value = manifest()
        duplicate = deepcopy(value["assets"][0])
        duplicate.update(id="another", path="assets/Portrait.png")
        value["assets"].append(duplicate)
        with self.assertRaisesRegex(team.ContractError, "INVALID_ASSET"):
            team.validate_asset_manifest(value)
        for dimensions in (None, {"width": 0, "height": 640}, {"width": True, "height": 640},
                           {"width": 360, "height": 16385}):
            value = manifest()
            value["assets"][0]["dimensions"] = dimensions
            with self.subTest(dimensions=dimensions), self.assertRaisesRegex(team.ContractError, "INVALID_ASSET_DIMENSIONS"):
                team.validate_asset_manifest(value)


if __name__ == "__main__":
    unittest.main()
