"""Run Make targets in parallel with CI-friendly reporting."""

from __future__ import annotations

import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass


@dataclass(frozen=True)
class CheckResult:
    """Outcome of one parallel check."""

    name: str
    passed: bool
    elapsed: float
    output: str


DEFAULT_TIMEOUT = 600


def run_check(name: str, *, timeout: int = DEFAULT_TIMEOUT, run_fn=None) -> CheckResult:
    """Run a single Make target and return the captured result."""
    start = time.monotonic()
    try:
        result = (run_fn or subprocess.run)(
            ["make", name],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return CheckResult(
            name=name,
            passed=False,
            elapsed=time.monotonic() - start,
            output=f"Timed out after {timeout}s",
        )
    except (OSError, ValueError) as exc:
        return CheckResult(
            name=name,
            passed=False,
            elapsed=time.monotonic() - start,
            output=f"Failed to run: {exc}",
        )

    return CheckResult(
        name=name,
        passed=result.returncode == 0,
        elapsed=time.monotonic() - start,
        output=(result.stdout + result.stderr).rstrip("\n"),
    )


def run_checks(
    targets: list[str], *, timeout: int = DEFAULT_TIMEOUT, run_fn=None
) -> tuple[CheckResult, ...]:
    """Run all targets in parallel and return results sorted by name."""
    with ThreadPoolExecutor() as pool:
        futures = {
            pool.submit(run_check, target, timeout=timeout, run_fn=run_fn): target
            for target in targets
        }
        results = [future.result() for future in as_completed(futures)]
    return tuple(sorted(results, key=lambda result: result.name))


def format_results(results: tuple[CheckResult, ...]) -> str:
    """Build CI log output with a concise summary and grouped passing logs."""
    summary = [
        f"{'✓' if result.passed else '✗'} {result.name} ({result.elapsed:.1f}s)"
        for result in results
    ]
    logs: list[str] = []
    for result in results:
        header = f"::group::{result.name}" if result.passed else f"--- {result.name} (failed) ---"
        footer = "::endgroup::" if result.passed else ""
        logs.extend(
            [
                header,
                result.output or "(no output)",
                *(line for line in [footer] if line),
            ]
        )

    failed = [result.name for result in results if not result.passed]
    error = [f"\n::error::Failed: {', '.join(failed)}"] if failed else []
    return "\n".join([*summary, "", *logs, *error])


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for running the provided Make targets in parallel."""
    args = argv if argv is not None else sys.argv[1:]
    timeout = DEFAULT_TIMEOUT
    usage = "Usage: run_parallel_checks.py [--timeout N] target1 target2 ..."

    if "--timeout" in args:
        index = args.index("--timeout")
        if index + 1 >= len(args):
            print("Error: --timeout requires an integer value.")
            print(usage)
            return 1
        try:
            timeout = int(args[index + 1])
        except ValueError:
            print(f"Error: invalid timeout value: {args[index + 1]!r}.")
            print(usage)
            return 1
        if timeout < 1:
            print(f"Error: timeout must be positive, got {timeout}.")
            print(usage)
            return 1
        args = args[:index] + args[index + 2 :]

    if not args:
        print(usage)
        return 1

    results = run_checks(args, timeout=timeout)
    print(format_results(results))
    return 0 if all(result.passed for result in results) else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
