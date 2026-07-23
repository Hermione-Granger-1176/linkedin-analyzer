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


def test_targeted_node_lock_update_is_package_scoped() -> None:
    """Keep transitive security refreshes explicit and lockfile-only."""
    recipe = _target_recipe("lock-node-update")

    assert 'test -n "$(packages)"' in recipe
    assert "$(NPM) update --package-lock-only $(packages)" in recipe
