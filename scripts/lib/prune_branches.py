#!/usr/bin/env python3
"""Prune local branches whose content already exists in the base branch.

An ancestry check can miss squash-merged branches because their original commits
are absent from the base history. Instead, ``git merge-tree --write-tree``
computes the result of merging each candidate without changing the checkout.

A result identical to the base tree makes the branch eligible for deletion.
A different tree or merge conflict preserves the branch. Deletion uses
``git branch -D`` because ``-d`` would repeat the ancestry check.

Make passes the protected base name through ``PRUNE_MAIN_BRANCH``. Only
``PRUNE_CONFIRM=1`` enables deletion. Other values report candidates without
deleting them.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence

# A runner takes the git command vector and returns the completed process.
# Injectable so tests never touch a real repository.
GitRunner = Callable[[Sequence[str]], "subprocess.CompletedProcess[str]"]

MERGE_TREE_HINT = "branch-prune needs git 2.38 or newer for merge-tree --write-tree."


def run_git(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    """Run one git command without a shell and capture its output."""
    return subprocess.run(["git", *command], capture_output=True, text=True, check=False)


def resolve_base(main_branch: str, *, runner: GitRunner = run_git) -> str:
    """Return the remote-tracking base when it exists, else the local branch."""
    remote = f"origin/{main_branch}"
    result = runner(["show-ref", "--verify", "--quiet", f"refs/remotes/{remote}"])
    return remote if result.returncode == 0 else main_branch


def local_branches(*, runner: GitRunner = run_git) -> list[str]:
    """Return every local branch name in ref order."""
    result = runner(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    return [line for line in result.stdout.splitlines() if line]


def current_branch(*, runner: GitRunner = run_git) -> str:
    """Return the checked-out branch name, or an empty string when detached."""
    return runner(["branch", "--show-current"]).stdout.strip()


def base_tree(base: str, *, runner: GitRunner = run_git) -> str:
    """Return the tree object id for the base branch tip."""
    result = runner(["rev-parse", f"{base}^{{tree}}"])
    if result.returncode != 0:
        raise RuntimeError(f"cannot resolve base branch {base}")
    return result.stdout.strip()


def is_contained(base: str, branch: str, tree: str, *, runner: GitRunner = run_git) -> bool:
    """Return whether merging the branch into the base would change nothing."""
    result = merge_tree_result(base, branch, runner=runner)
    if result.returncode != 0:
        return False
    return result.stdout.strip() == tree


def classify(
    base: str,
    branches: Sequence[str],
    tree: str,
    *,
    runner: GitRunner = run_git,
) -> tuple[list[str], list[str]]:
    """Split candidate branches into fully contained and possibly unique."""
    contained: list[str] = []
    unique: list[str] = []
    for branch in branches:
        if is_contained(base, branch, tree, runner=runner):
            contained.append(branch)
        else:
            unique.append(branch)
    return contained, unique


def candidate_branches(
    environ: Mapping[str, str], *, runner: GitRunner = run_git
) -> tuple[str, list[str]]:
    """Return the base branch and every local branch eligible for a decision."""
    main_branch = environ.get("PRUNE_MAIN_BRANCH") or "main"
    protected = {main_branch, current_branch(runner=runner)}
    base = resolve_base(main_branch, runner=runner)
    return base, [branch for branch in local_branches(runner=runner) if branch not in protected]


def supports_merge_tree(base: str, *, runner: GitRunner = run_git) -> bool:
    """Return whether this git build understands ``merge-tree --write-tree``."""
    return merge_tree_result(base, base, runner=runner).returncode == 0


def merge_tree_result(
    base: str, branch: str, *, runner: GitRunner = run_git
) -> subprocess.CompletedProcess[str]:
    """Run merge-tree and preserve its output for callers that report errors."""
    return runner(["merge-tree", "--write-tree", base, branch])


def merge_tree_error_detail(result: subprocess.CompletedProcess[str]) -> str:
    """Return diagnostic output without mistaking a tree id for an error."""
    stderr = result.stderr.strip()
    if stderr:
        return stderr

    stdout = result.stdout.strip()
    error_prefixes = ("error:", "fatal:", "usage:")
    if any(line.lower().startswith(error_prefixes) for line in stdout.splitlines()):
        return stdout
    return ""


def _resolve_base_tree(base: str, *, runner: GitRunner) -> str | None:
    """Return the base tree id, or print why the prune cannot run and return None."""
    # Resolve the base before probing for merge-tree support. Both fail the same
    # way on an old git and on a missing base, so checking capability first would
    # blame the git version for what is really an unresolvable ref.
    try:
        tree = base_tree(base, runner=runner)
    except RuntimeError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return None

    merge_tree_check = merge_tree_result(base, base, runner=runner)
    if merge_tree_check.returncode != 0:
        detail = merge_tree_error_detail(merge_tree_check)
        if detail:
            print(f"ERROR: git merge-tree --write-tree failed: {detail}", file=sys.stderr)
        else:
            print(MERGE_TREE_HINT, file=sys.stderr)
        return None
    return tree


def _print_branches(heading: str, branches: Sequence[str]) -> None:
    """Print a heading followed by one indented branch name per line."""
    print(heading)
    for branch in branches:
        print(f"  {branch}")


def _delete_branches(branches: Sequence[str], *, runner: GitRunner) -> int:
    """Force-delete each branch and return the exit code.

    Deletion is the destructive step, so a refusal stops the run rather than
    continuing down the list. git explains itself on stderr, which the caller
    needs to see to know whether anything was actually removed.
    """
    for branch in branches:
        result = runner(["branch", "-D", branch])
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip() or "git reported no detail"
            print(f"ERROR: cannot delete {branch}: {detail}", file=sys.stderr)
            return 1
        print(result.stdout.strip() or f"Deleted branch {branch}")
    return 0


def main(
    arguments: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    runner: GitRunner = run_git,
) -> int:
    """Report contained and unique branches, deleting the contained ones on confirm."""
    del arguments
    env = os.environ if environ is None else environ
    base, branches = candidate_branches(env, runner=runner)

    tree = _resolve_base_tree(base, runner=runner)
    if tree is None:
        return 1

    contained, unique = classify(base, branches, tree, runner=runner)

    if unique:
        _print_branches(
            f"Branches holding content not in {base} (kept, review before deleting):", unique
        )

    if not contained:
        print(f"No local branches are fully contained in {base}.")
        return 0

    _print_branches(f"Branches fully contained in {base} (safe to prune):", contained)

    if env.get("PRUNE_CONFIRM") != "1":
        print("Dry run only. Re-run with confirm=1 to delete them.")
        return 0

    return _delete_branches(contained, runner=runner)


if __name__ == "__main__":
    raise SystemExit(main())
