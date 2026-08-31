#!/usr/bin/env python3
"""Development-only TOML and in-memory handoff structure checks; no release authority."""

from __future__ import annotations

import json
from pathlib import Path
import re
import stat
import sys
import tomllib


ROLES = (
    "game_orchestrator",
    "scenario_designer",
    "art_director",
    "gameplay_engineer",
    "asset_manager",
)
ROLE_STEPS = {
    "game_orchestrator": ("step01_", "step06_"),
    "scenario_designer": ("step02_",),
    "art_director": ("step03_",),
    "gameplay_engineer": ("step04_",),
    "asset_manager": ("step05_",),
}
POLICY_VERSION = "teen-v1"
MAX_SAFE_INTEGER = 2**53 - 1
MAX_BYTES = 64 * 1024 * 1024
HASH = re.compile(r"[a-f0-9]{64}")
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{8,128}")
PATH_SEGMENT = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*")
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {
    f"{prefix}{number}" for prefix in ("COM", "LPT") for number in range(1, 10)
}
CHECKS = {
    "source_binding", "path_scope", "input_schema", "scenario_consistency",
    "teen_content", "localization", "touch_keyboard", "pause_resume",
    "save_boundary", "asset_provenance", "artifact_hashes", "code_behavior",
}
BLOCKERS = {
    "ISOLATION_UNAVAILABLE", "INPUT_GATE_BLOCKED", "SNAPSHOT_CHANGED",
    "SAFETY_REVIEW_PENDING", "NO_ELIGIBLE_PROPOSALS",
    "REQUIREMENT_DECISION_REQUIRED", "ARTIFACT_INVALID", "LICENSE_UNVERIFIED",
    "CHECK_FAILED", "RELEASE_REVIEW_UNAVAILABLE", "OPERATION_CANCELLED",
}
MEDIA_TYPES = {
    "image/png", "image/webp", "image/svg+xml", "audio/ogg", "audio/wav", "font/woff2",
}


class ContractError(ValueError):
    """Only fixed, non-sensitive error codes may leave these validators."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise ContractError(code)


def exact(value: object, keys: set[str]) -> bool:
    return type(value) is dict and set(value) == keys


def integer(value: object, minimum: int = 1, maximum: int = MAX_SAFE_INTEGER) -> bool:
    return type(value) is int and minimum <= value <= maximum


def matches(pattern: re.Pattern[str], value: object) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def relative_file(value: object, directory: str, role: str | None = None) -> bool:
    """Lexical path check only. Actual file/link checks belong to the trusted importer."""
    if not isinstance(value, str) or not 3 <= len(value) <= 240:
        return False
    parts = value.split("/")
    if len(parts) < 2 or parts[0] != directory:
        return False
    if any(not PATH_SEGMENT.fullmatch(part) or part.endswith(".")
           or part.split(".")[0].upper() in RESERVED for part in parts):
        return False
    if directory == "output":
        if not re.match(r"step0[1-6]_[a-z0-9]", parts[1]):
            return False
        if role is not None and not parts[1].startswith(ROLE_STEPS[role]):
            return False
    return "." in parts[-1]


def validate_source_binding(value: object) -> None:
    require(exact(value, {"snapshotDigest", "policyVersion", "proposals"}), "INVALID_SOURCE_BINDING")
    require(matches(HASH, value["snapshotDigest"]) and value["policyVersion"] == POLICY_VERSION,
            "INVALID_SOURCE_BINDING")
    rows = value["proposals"]
    require(type(rows) is list and 1 <= len(rows) <= 100000, "INVALID_SOURCE_BINDING")
    seen = set()
    for row in rows:
        require(exact(row, {"id", "revision", "bodyHash", "policyVersion", "safetyReviewId",
                            "safetyRevision", "developmentBriefHash"}), "INVALID_SOURCE_BINDING")
        require(matches(IDENTIFIER, row["id"]) and row["id"] not in seen
                and matches(IDENTIFIER, row["safetyReviewId"])
                and integer(row["revision"]) and integer(row["safetyRevision"])
                and row["policyVersion"] == POLICY_VERSION
                and matches(HASH, row["bodyHash"]) and matches(HASH, row["developmentBriefHash"]),
                "INVALID_SOURCE_BINDING")
        seen.add(row["id"])


def validate_handoff(value: object, *, expected_run_id: str | None = None,
                     expected_source_binding: dict | None = None) -> dict:
    require(exact(value, {"schemaVersion", "runId", "role", "status", "input", "sourceBinding",
                          "artifacts", "checks", "blockers"}), "INVALID_HANDOFF")
    require(integer(value["schemaVersion"], 1, 1) and matches(IDENTIFIER, value["runId"])
            and value["role"] in ROLES and value["status"] in ("complete", "blocked", "failed"),
            "INVALID_HANDOFF")
    if expected_run_id is not None:
        require(value["runId"] == expected_run_id, "HANDOFF_RUN_MISMATCH")
    inputs = value["input"]
    require(exact(inputs, {"snapshotPath", "inputGatePath", "isolationPath", "upstreamHandoffs"}),
            "INVALID_HANDOFF_INPUT")
    for key in ("snapshotPath", "inputGatePath", "isolationPath"):
        require(inputs[key] is None or relative_file(inputs[key], "input"), "INVALID_HANDOFF_INPUT")
    upstream = inputs["upstreamHandoffs"]
    require(type(upstream) is list and len(upstream) <= 5
            and all(relative_file(item, "output") for item in upstream), "INVALID_HANDOFF_INPUT")
    require(len({item.lower() for item in upstream}) == len(upstream), "INVALID_HANDOFF_INPUT")
    if value["sourceBinding"] is not None:
        validate_source_binding(value["sourceBinding"])
    if expected_source_binding is not None:
        validate_source_binding(expected_source_binding)
        require(value["sourceBinding"] == expected_source_binding, "HANDOFF_SOURCE_MISMATCH")

    artifacts = value["artifacts"]
    require(type(artifacts) is list and len(artifacts) <= 1024, "INVALID_HANDOFF_ARTIFACT")
    paths, total_bytes = set(), 0
    for artifact in artifacts:
        require(exact(artifact, {"path", "sha256", "bytes"})
                and relative_file(artifact["path"], "output", value["role"])
                and matches(HASH, artifact["sha256"])
                and integer(artifact["bytes"], 0, MAX_BYTES), "INVALID_HANDOFF_ARTIFACT")
        require(artifact["path"].lower() not in paths, "INVALID_HANDOFF_ARTIFACT")
        paths.add(artifact["path"].lower())
        total_bytes += artifact["bytes"]
    require(total_bytes <= MAX_BYTES, "INVALID_HANDOFF_ARTIFACT")

    checks = value["checks"]
    require(type(checks) is list and len(checks) <= len(CHECKS), "INVALID_HANDOFF_CHECK")
    names = set()
    for check in checks:
        require(exact(check, {"name", "result", "evidencePath"}), "INVALID_HANDOFF_CHECK")
        require(isinstance(check["name"], str) and check["name"] in CHECKS and check["name"] not in names
                and check["result"] in ("pass", "fail", "not_run"), "INVALID_HANDOFF_CHECK")
        require(relative_file(check["evidencePath"], "output")
                or (check["result"] == "not_run" and check["evidencePath"] is None), "INVALID_HANDOFF_CHECK")
        names.add(check["name"])
    blockers = value["blockers"]
    require(type(blockers) is list and len(blockers) <= len(BLOCKERS)
            and all(isinstance(code, str) and code in BLOCKERS for code in blockers), "INVALID_HANDOFF_BLOCKER")
    require(len(set(blockers)) == len(blockers), "INVALID_HANDOFF_BLOCKER")
    if value["status"] == "complete":
        require(value["sourceBinding"] is not None and artifacts and not blockers
                and all(inputs[key] is not None for key in ("snapshotPath", "inputGatePath", "isolationPath"))
                and {"source_binding", "path_scope"} <= names
                and all(check["result"] == "pass" for check in checks), "INCOMPLETE_HANDOFF")
    else:
        require(bool(blockers), "INVALID_HANDOFF_BLOCKER")
    return {"structureValid": True, "artifacts": len(artifacts), "checks": len(checks),
            "releaseAllowed": False, "evidenceAuthenticityVerified": False}


def validate_asset_manifest(value: object, *, expected_run_id: str | None = None,
                            expected_snapshot_digest: str | None = None) -> dict:
    require(exact(value, {"schemaVersion", "runId", "policyVersion", "snapshotDigest", "assets"}),
            "INVALID_ASSET_MANIFEST")
    require(integer(value["schemaVersion"], 1, 1) and matches(IDENTIFIER, value["runId"])
            and value["policyVersion"] == POLICY_VERSION and matches(HASH, value["snapshotDigest"]),
            "INVALID_ASSET_MANIFEST")
    if expected_run_id is not None:
        require(value["runId"] == expected_run_id, "ASSET_RUN_MISMATCH")
    if expected_snapshot_digest is not None:
        require(value["snapshotDigest"] == expected_snapshot_digest, "ASSET_SOURCE_MISMATCH")
    assets = value["assets"]
    require(type(assets) is list and len(assets) <= 1024, "INVALID_ASSET_MANIFEST")
    ids, paths, total_bytes = set(), set(), 0
    for asset in assets:
        require(exact(asset, {"id", "path", "mediaType", "sha256", "bytes", "dimensions", "license",
                              "provenance", "ownerRole", "revision"}), "INVALID_ASSET")
        require(isinstance(asset["id"], str) and re.fullmatch(r"[a-z0-9_]{1,64}", asset["id"])
                and asset["id"] not in ids and relative_file(asset["path"], "assets")
                and asset["path"].lower() not in paths and matches(HASH, asset["sha256"])
                and integer(asset["bytes"], 1, MAX_BYTES) and asset["ownerRole"] in ROLES
                and integer(asset["revision"]) and isinstance(asset["mediaType"], str)
                and asset["mediaType"] in MEDIA_TYPES, "INVALID_ASSET")
        dimensions = asset["dimensions"]
        require((exact(dimensions, {"width", "height"}) and integer(dimensions["width"], 1, 16384)
                 and integer(dimensions["height"], 1, 16384)) if asset["mediaType"].startswith("image/")
                else dimensions is None, "INVALID_ASSET_DIMENSIONS")
        license_info = asset["license"]
        require(exact(license_info, {"id", "evidencePath", "attributionRequired"})
                and isinstance(license_info["id"], str)
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+-]{0,127}", license_info["id"])
                and relative_file(license_info["evidencePath"], "input")
                and type(license_info["attributionRequired"]) is bool, "INVALID_ASSET_LICENSE")
        provenance = asset["provenance"]
        require(exact(provenance, {"kind", "sourceRef"})
                and provenance["kind"] in ("codex_original", "human_original", "licensed_import")
                and relative_file(provenance["sourceRef"], "input"), "INVALID_ASSET_PROVENANCE")
        ids.add(asset["id"])
        paths.add(asset["path"].lower())
        total_bytes += asset["bytes"]
    require(total_bytes <= MAX_BYTES, "INVALID_ASSET_MANIFEST")
    return {"structureValid": True, "assets": len(assets), "releaseAllowed": False,
            "artifactBytesVerified": False, "licenseRightsVerified": False}


def read_config(file: Path) -> dict:
    try:
        metadata = file.lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                and 0 < metadata.st_size <= 65536, "INVALID_CONFIG_FILE")
        return tomllib.loads(file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError):
        raise ContractError("CONFIG_PARSE_FAILED") from None


def validate_team(root: Path) -> dict:
    config = read_config(root / ".codex" / "config.toml")
    require(exact(config, {"agents"}) and exact(config["agents"], {"max_concurrent_threads_per_session"})
            and integer(config["agents"]["max_concurrent_threads_per_session"], 3, 3), "INVALID_TEAM_CONFIG")
    for role in ROLES:
        agent = read_config(root / ".codex" / "agents" / f"{role}.toml")
        require(exact(agent, {"name", "description", "developer_instructions"})
                and agent["name"] == role and isinstance(agent["description"], str)
                and 1 <= len(agent["description"].strip()) <= 300
                and isinstance(agent["developer_instructions"], str)
                and 1 <= len(agent["developer_instructions"].strip()) <= 16000, "INVALID_AGENT_CONFIG")
        instructions = agent["developer_instructions"]
        require(all(token in instructions for token in ("docs/game-agent-workflow.md", "snapshot v2",
                    "input-gate", "handoff-v1", "ISOLATION_UNAVAILABLE", "RELEASE_REVIEW_UNAVAILABLE")),
                "MISSING_AGENT_CONTRACT_REFERENCE")
    require((root / "docs" / "game-agent-workflow.md").is_file()
            and (root / "blueprint-game-development.md").is_file(), "MISSING_TEAM_DOCUMENT")
    return {"ok": True, "scope": "game_agent_structure", "customAgents": len(ROLES),
            "maxSpawnedThreads": 3, "explicitModelOverrides": 0, "roleExecutionVerified": False,
            "isolationVerified": False, "releaseAllowed": False}


def main(args: list[str]) -> int:
    if args == ["--help"]:
        print("Usage: python scripts/check-game-agent-team.py [PROJECT_ROOT]\n"
              "Python 3.11+ development-only structural check. No generation, DB access or release authority.")
        return 0
    try:
        require(len(args) <= 1 and (not args or not args[0].startswith("-")), "INVALID_ARGUMENTS")
        root = Path(args[0]) if args else Path(__file__).resolve().parent.parent
        result = validate_team(root)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except (ContractError, OSError):
        # Do not echo a path, malformed TOML, arbitrary exception or source data.
        print(json.dumps({"ok": False, "scope": "game_agent_structure",
                          "code": "TEAM_STRUCTURE_INVALID", "releaseAllowed": False}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
