from __future__ import annotations

import re
from pathlib import Path

MAKEFILE_TEXT = (Path(__file__).parents[1] / "Makefile").read_text(encoding="utf-8")


def _target_recipe(name: str) -> str:
    """Return the recipe lines for one Makefile target."""
    match = re.search(
        rf"^{re.escape(name)}:.*\n(?P<recipe>(?:\t.*\n)+)",
        MAKEFILE_TEXT,
        re.MULTILINE,
    )
    assert match is not None, f"missing Makefile target: {name}"
    return match.group("recipe")


def test_playwright_uses_native_host_detection() -> None:
    """Do not retain the obsolete Ubuntu platform override workaround."""
    assert "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE" not in MAKEFILE_TEXT
    assert "PLAYWRIGHT_SUPPORTED_UBUNTU" not in MAKEFILE_TEXT


def test_playwright_runtime_is_linted_and_type_checked() -> None:
    """Keep the setup utility in both Python quality scopes."""
    assert re.search(r"^PY_PATHS\s*:=.*scripts/setup/", MAKEFILE_TEXT, re.MULTILINE)
    assert re.search(r"^PY_TYPE_PATHS\s*:=.*scripts/setup/", MAKEFILE_TEXT, re.MULTILINE)


def test_local_playwright_setup_avoids_system_dependencies() -> None:
    """Keep local browser installation sudo-free."""
    recipe = _target_recipe("setup-playwright")

    assert "playwright install $(PLAYWRIGHT_BROWSERS)" in recipe
    assert "--with-deps" not in recipe


def test_ci_playwright_setup_installs_system_dependencies() -> None:
    """Keep Playwright's system dependency installation in the CI-only target."""
    recipe = _target_recipe("setup-playwright-ci")

    assert "playwright install --with-deps $(PLAYWRIGHT_BROWSERS)" in recipe


def test_local_playwright_runtime_setup_prepares_libs_and_shares_browsers() -> None:
    """Prepare private libraries around a shared, sudo-free browser install."""
    recipe = _target_recipe("setup-playwright-local")

    prepare = "$(PLAYWRIGHT_LOCAL_RUNTIME) prepare"
    # Browsers install into Playwright's shared cache, so no repository-local
    # browser path or private install environment is layered onto the install.
    assert "PLAYWRIGHT_LOCAL_INSTALL_ENV" not in MAKEFILE_TEXT
    assert "PLAYWRIGHT_LOCAL_BROWSERS" not in MAKEFILE_TEXT
    assert "PLAYWRIGHT_BROWSERS_PATH" not in recipe
    assert recipe.count(prepare) == 2
    assert "$(NPX) playwright install $(PLAYWRIGHT_BROWSERS)" in recipe
    assert recipe.index(prepare) < recipe.index("playwright install") < recipe.rindex(prepare)
    assert "--with-deps" not in recipe


def test_clean_removes_the_repository_local_playwright_cache() -> None:
    """Make clean should drop the repository-local Playwright cache too."""
    recipe = _target_recipe("clean")

    assert " .playwright " in recipe


def test_browser_targets_share_the_local_runtime_wrapper() -> None:
    """Require local_libs=1 to route every existing browser target through one wrapper."""
    assert (
        "PLAYWRIGHT_LOCAL_RUN = $(if $(filter 1,$(local_libs)),$(PLAYWRIGHT_LOCAL_RUNTIME) run --,)"
        in MAKEFILE_TEXT
    )
    for target in ("test-e2e", "test-e2e-headed", "test-e2e-ui", "web-screens"):
        assert "$(PLAYWRIGHT_LOCAL_RUN)" in _target_recipe(target)


def test_local_playwright_runtime_targets_are_exposed() -> None:
    """Keep all lifecycle and real-engine gate entry points discoverable through Make."""
    for target, action in (
        ("playwright-local-status", "status"),
        ("playwright-local-gate", "probe"),
        ("playwright-local-clean", "clean"),
    ):
        assert f"$(PLAYWRIGHT_LOCAL_RUNTIME) {action}" in _target_recipe(target)


def test_playwright_setup_installs_all_browser_engines() -> None:
    """Keep Chromium, Firefox, and WebKit in the shared browser list."""
    match = re.search(r"^PLAYWRIGHT_BROWSERS\s*:=\s*(?P<browsers>.+)$", MAKEFILE_TEXT, re.MULTILINE)
    assert match is not None
    assert match.group("browsers").split() == ["chromium", "firefox", "webkit"]


def test_targeted_node_lock_update_is_package_scoped() -> None:
    """Keep transitive security refreshes explicit and lockfile-only."""
    recipe = _target_recipe("lock-node-update")

    assert 'test -n "$(packages)"' in recipe
    assert "$(NPM) update --package-lock-only $(packages)" in recipe
