from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]


def run_make_target(
    tmp_path: Path,
    target: str,
    *assignments: str,
    variables: dict[str, str] | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path]:
    """Run a branch helper with a fake Git executable and capture its arguments."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir(exist_ok=True)
    args_file = tmp_path / "git-args"
    fake_git = fake_bin / "git"
    fake_git.write_text(
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$GIT_ARGS_FILE"\n',
        encoding="utf-8",
    )
    fake_git.chmod(0o755)

    environment = os.environ.copy()
    environment.update(variables or {})
    environment["GIT_ARGS_FILE"] = str(args_file)
    environment["PATH"] = f"{fake_bin}{os.pathsep}{environment['PATH']}"
    result = subprocess.run(
        ["make", target, *assignments],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    return result, args_file


@pytest.mark.parametrize("target", ["branch-switch", "branch-delete"])
def test_branch_helpers_require_a_name(target: str, tmp_path: Path) -> None:
    """Both helpers reject a missing name before invoking Git."""
    result, args_file = run_make_target(tmp_path, target)

    assert result.returncode != 0
    assert f"Usage: make {target} name=" in result.stderr
    assert not args_file.exists()


@pytest.mark.parametrize(
    ("target", "expected_prefix"),
    [
        ("branch-switch", ["switch", "--"]),
        ("branch-delete", ["branch", "-d", "--"]),
    ],
)
def test_branch_helpers_pass_shell_metacharacters_as_literal_names(
    target: str, expected_prefix: list[str], tmp_path: Path
) -> None:
    """Branch names stay literal when they contain Make and shell syntax."""
    marker = tmp_path / "expanded"
    name = f"feature`touch {marker}`"
    result, args_file = run_make_target(tmp_path, target, f"name={name}")

    assert result.returncode == 0, result.stderr
    assert args_file.read_text(encoding="utf-8").splitlines() == [*expected_prefix, name]
    assert not marker.exists()


@pytest.mark.parametrize(
    ("target", "expected_prefix"),
    [
        ("branch-switch", ["switch", "--"]),
        ("branch-delete", ["branch", "-d", "--"]),
    ],
)
def test_branch_helpers_preserve_make_syntax_from_environment(
    target: str, expected_prefix: list[str], tmp_path: Path
) -> None:
    """Environment values keep Make functions inert until Git receives them."""
    marker = tmp_path / "expanded-from-environment"
    name = f"feature$(shell touch {marker})"
    result, args_file = run_make_target(tmp_path, target, variables={"name": name})

    assert result.returncode == 0, result.stderr
    assert args_file.read_text(encoding="utf-8").splitlines() == [*expected_prefix, name]
    assert not marker.exists()


def test_branch_delete_force_selects_force_delete(tmp_path: Path) -> None:
    """The force flag selects Git's force-delete option without changing the name."""
    name = "feature/old"
    result, args_file = run_make_target(tmp_path, "branch-delete", f"name={name}", "force=1")

    assert result.returncode == 0, result.stderr
    assert args_file.read_text(encoding="utf-8").splitlines() == ["branch", "-D", "--", name]


def test_branch_delete_preserves_force_make_syntax_from_environment(tmp_path: Path) -> None:
    """An environment force value with Make syntax selects the safe default option."""
    marker = tmp_path / "expanded-force"
    force = f"$(shell touch {marker})"
    result, args_file = run_make_target(
        tmp_path,
        "branch-delete",
        variables={"name": "feature/old", "force": force},
    )

    assert result.returncode == 0, result.stderr
    assert args_file.read_text(encoding="utf-8").splitlines() == [
        "branch",
        "-d",
        "--",
        "feature/old",
    ]
    assert not marker.exists()
