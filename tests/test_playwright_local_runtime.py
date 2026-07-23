from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from scripts.setup import playwright_local_runtime as runtime

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence


def _manifest(version: str = "1.61.1") -> runtime.CacheManifest:
    return runtime.CacheManifest(
        schema=runtime.MANIFEST_SCHEMA,
        host=runtime.current_host(),
        playwright_version=version,
        engines=runtime.ENGINES,
        packages=(runtime.PackageVersion(name="libdemo0", version="1:2.0-1ubuntu1"),),
    )


def _ready_paths(tmp_path: Path) -> runtime.RuntimePaths:
    paths = runtime.RuntimePaths.from_repo(tmp_path, browser_root=tmp_path / "shared-browsers")
    metadata = paths.repo_root / "node_modules" / "@playwright" / "test" / "package.json"
    metadata.parent.mkdir(parents=True)
    metadata.write_text('{"version": "1.61.1"}\n', encoding="utf-8")
    runtime.ensure_cache_root(paths)
    paths.extracted_root.mkdir(parents=True)
    runtime.write_manifest(paths.manifest, _manifest())
    for engine in runtime.ENGINES:
        (paths.browser_root / f"{engine}-test").mkdir(parents=True)
    webkit_launcher = paths.browser_root / "webkit-test" / "minibrowser-wpe" / "MiniBrowser"
    webkit_launcher.parent.mkdir()
    webkit_launcher.write_text(
        f"#!/bin/sh\n{runtime.WEBKIT_LAUNCHER_LOCAL_LD_LINE}\n",
        encoding="utf-8",
    )
    webkit_launcher.chmod(0o755)
    return paths


def test_parse_dependency_seeds_accepts_only_package_tokens() -> None:
    """Accept the legacy printed install command without evaluating it."""
    output = """
Installing dependencies...
sudo apt-get install -y --no-install-recommends \\
  libgtk-3-0 libnss3
"""

    assert runtime.parse_dependency_seeds(output) == ("libgtk-3-0", "libnss3")


def test_parse_dependency_seeds_accepts_playwright_missing_package_report() -> None:
    """Accept the current Playwright dry-run missing-package report."""
    output = """
Missing system dependencies (2):
  libgtk-3-0
  libnss3
"""

    assert runtime.parse_dependency_seeds(output) == ("libgtk-3-0", "libnss3")


def test_parse_dependency_seeds_rejects_shell_syntax() -> None:
    """Reject shell operators in dry-run output even though it is never executed."""
    output = "sudo apt-get install libgtk-3-0; touch unexpected\n"

    with pytest.raises(runtime.RuntimeSetupError, match="unsafe shell syntax"):
        runtime.parse_dependency_seeds(output)


def test_parse_dependency_seeds_rejects_incomplete_missing_package_report() -> None:
    """Require the declared dry-run package count to match the parsed list."""
    output = "Missing system dependencies (2):\n  libgtk-3-0\n"

    with pytest.raises(runtime.RuntimeSetupError, match="incomplete package list"):
        runtime.parse_dependency_seeds(output)


def test_parse_simulated_packages_requires_safe_exact_versions() -> None:
    """Parse only exact safe package names and versions from APT simulation."""
    output = """
Inst libdemo0:amd64 (1:2.0~rc1-3ubuntu1.4 Ubuntu:26.04/oracular [amd64])
Inst libother0 (4.5-1 Ubuntu:26.04/oracular [amd64])
"""

    assert runtime.parse_simulated_packages(output) == (
        runtime.PackageVersion(name="libdemo0:amd64", version="1:2.0~rc1-3ubuntu1.4"),
        runtime.PackageVersion(name="libother0", version="4.5-1"),
    )


def test_parse_simulated_packages_rejects_malformed_package_data() -> None:
    """Reject a package name that could escape the private archive directory."""
    output = "Inst ../outside (1.0 Ubuntu:26.04/oracular [amd64])\n"

    with pytest.raises(runtime.RuntimeSetupError, match="malformed package data"):
        runtime.parse_simulated_packages(output)


def test_cache_reuse_requires_the_complete_manifest_and_runtime_root(tmp_path: Path) -> None:
    """Invalidate reuse on identity changes or an incomplete extracted root."""
    paths = _ready_paths(tmp_path)

    assert runtime.cache_matches(paths, _manifest())
    assert not runtime.cache_matches(paths, _manifest(version="1.62.0"))

    paths.extracted_root.rmdir()

    assert not runtime.cache_matches(paths, _manifest())


def test_atomic_publish_failure_keeps_the_previous_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep the active cache intact when an atomic directory exchange fails."""
    paths = runtime.RuntimePaths.from_repo(tmp_path)
    runtime.ensure_cache_root(paths)
    (paths.extracted_root).mkdir(parents=True)
    old_marker = paths.local_libraries / "old-cache"
    old_marker.write_text("keep", encoding="utf-8")
    staged = paths.cache_root / ".stage-test" / "local-libs"
    (staged / "root").mkdir(parents=True)

    def fail_exchange(_left: Path, _right: Path) -> None:
        raise runtime.RuntimeSetupError("injected exchange failure")

    monkeypatch.setattr(runtime, "exchange_directories", fail_exchange)

    with pytest.raises(runtime.RuntimeSetupError, match="injected exchange failure"):
        runtime.publish_local_libraries(paths, staged)

    assert old_marker.read_text(encoding="utf-8") == "keep"
    assert (staged / "root").is_dir()


def test_validate_extracted_root_rejects_host_libc_and_escaping_symlinks(tmp_path: Path) -> None:
    """Reject loader overlays and links that resolve outside the runtime root."""
    libc_root = tmp_path / "libc-root"
    libc = libc_root / "usr" / "lib" / "x86_64-linux-gnu" / "libc.so.6"
    libc.parent.mkdir(parents=True)
    libc.write_text("not a library", encoding="utf-8")

    with pytest.raises(runtime.RuntimeSetupError, match="loader or libc overlay"):
        runtime.validate_extracted_root(libc_root)

    symlink_root = tmp_path / "symlink-root"
    escaped_link = symlink_root / "usr" / "lib" / "x86_64-linux-gnu" / "escape"
    escaped_link.parent.mkdir(parents=True)
    escaped_link.symlink_to(tmp_path / "outside")

    with pytest.raises(runtime.RuntimeSetupError, match="escaped"):
        runtime.validate_extracted_root(symlink_root)


def test_validate_extracted_root_rejects_usr_lib64_host_overlay(tmp_path: Path) -> None:
    """Guard usr/lib64 loader and libc overlays that runtime discovery would trust."""
    loader_root = tmp_path / "loader-root"
    loader = loader_root / "usr" / "lib64" / "ld-linux-x86-64.so.2"
    loader.parent.mkdir(parents=True)
    loader.write_text("not a loader", encoding="utf-8")

    with pytest.raises(runtime.RuntimeSetupError, match="loader or libc overlay"):
        runtime.validate_extracted_root(loader_root)

    libc_root = tmp_path / "libc64-root"
    libc = libc_root / "usr" / "lib64" / "libc.so.6"
    libc.parent.mkdir(parents=True)
    libc.write_text("not a library", encoding="utf-8")

    with pytest.raises(runtime.RuntimeSetupError, match="loader or libc overlay"):
        runtime.validate_extracted_root(libc_root)


def test_run_action_drops_the_make_wrapper_separator() -> None:
    """Strip the leading -- so the wrapped command reaches exec unaltered."""
    wrapped = runtime.parse_args(
        ["run", "--", "npm", "run", "test:e2e", "--", "--project=chromium"]
    )
    assert wrapped.command == ["npm", "run", "test:e2e", "--", "--project=chromium"]

    direct = runtime.parse_args(["run", "node", "-e", "code"])
    assert direct.command == ["node", "-e", "code"]


def test_cache_root_refuses_symlink(tmp_path: Path) -> None:
    """Refuse a cache root that redirects writes outside the repository."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / ".playwright").symlink_to(outside, target_is_directory=True)

    with pytest.raises(runtime.RuntimeSetupError, match="not a symlink"):
        runtime.ensure_cache_root(runtime.RuntimePaths.from_repo(tmp_path))


def test_browser_cache_ready_accepts_a_symlinked_shared_cache(tmp_path: Path) -> None:
    """A symlinked user browser cache (a common ~/.cache redirect) stays usable."""
    paths = _ready_paths(tmp_path)
    assert runtime.browser_cache_ready(paths)

    real_cache = tmp_path / "real-cache"
    paths.browser_root.rename(real_cache)
    paths.browser_root.symlink_to(real_cache, target_is_directory=True)

    assert paths.browser_root.is_symlink()
    assert runtime.browser_cache_ready(paths)


def test_cache_root_refuses_dangling_symlink(tmp_path: Path) -> None:
    """Reject a broken symlink root that exists() would silently skip."""
    (tmp_path / ".playwright").symlink_to(tmp_path / "missing", target_is_directory=True)

    with pytest.raises(runtime.RuntimeSetupError, match="not a symlink"):
        runtime.ensure_cache_root(runtime.RuntimePaths.from_repo(tmp_path))


def test_runtime_environment_prepends_only_discovered_private_paths(tmp_path: Path) -> None:
    """Build runtime paths from extracted content while preserving host values."""
    paths = _ready_paths(tmp_path)
    library_dir = paths.extracted_root / "usr" / "lib" / "x86_64-linux-gnu"
    library_dir.mkdir(parents=True)
    (library_dir / "libdemo.so.1").write_text("", encoding="utf-8")
    (paths.extracted_root / "usr" / "bin").mkdir(parents=True)
    (paths.extracted_root / "usr" / "share").mkdir(parents=True)
    (library_dir / "girepository-1.0").mkdir()
    plugin_dir = library_dir / "gstreamer-1.0"
    plugin_dir.mkdir()
    (plugin_dir / "libgstplugin.so").write_text("", encoding="utf-8")
    schema_dir = paths.extracted_root / "usr" / "share" / "glib-2.0" / "schemas"
    schema_dir.mkdir(parents=True)

    environment = runtime.runtime_environment(
        paths,
        {
            "HOME": "/host/home",
            "LD_LIBRARY_PATH": "/host/lib",
            "PATH": "/host/bin",
            "XDG_DATA_DIRS": "/host/share",
            "GI_TYPELIB_PATH": "/host/typelibs",
            "GST_PLUGIN_PATH_1_0": "/host/plugins",
            "GSETTINGS_SCHEMA_DIR": "/host/schemas",
        },
    )

    assert environment["PLAYWRIGHT_BROWSERS_PATH"] == str(paths.browser_root)
    assert environment["HOME"] == str(paths.runtime_home)
    assert environment["XDG_CACHE_HOME"] == str(paths.runtime_cache)
    assert environment["XDG_CONFIG_HOME"] == str(paths.runtime_config)
    assert environment["XDG_RUNTIME_DIR"] == str(paths.runtime_run)
    assert environment["TMPDIR"] == str(paths.runtime_tmp)
    assert environment["npm_config_cache"] == str(paths.runtime_cache / "npm")
    assert environment["PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS"] == "1"
    assert environment["LD_LIBRARY_PATH"] == f"{library_dir}{os.pathsep}/host/lib"
    assert str(plugin_dir) not in environment["LD_LIBRARY_PATH"]
    assert environment["PATH"] == f"{paths.extracted_root / 'usr' / 'bin'}{os.pathsep}/host/bin"
    assert environment["XDG_DATA_DIRS"] == (
        f"{paths.extracted_root / 'usr' / 'share'}{os.pathsep}/host/share"
    )
    assert environment["GI_TYPELIB_PATH"].endswith(f"{os.pathsep}/host/typelibs")
    assert environment["GST_PLUGIN_PATH_1_0"].endswith(f"{os.pathsep}/host/plugins")
    assert environment["GSETTINGS_SCHEMA_DIR"].endswith(f"{os.pathsep}/host/schemas")


def test_clean_removes_only_the_repository_local_cache(tmp_path: Path) -> None:
    """Remove the ignored runtime cache without touching a sibling or shared browsers."""
    paths = _ready_paths(tmp_path)
    sibling = tmp_path / "keep.txt"
    sibling.write_text("keep", encoding="utf-8")

    runtime.clean(paths)

    assert not paths.cache_root.exists()
    assert sibling.read_text(encoding="utf-8") == "keep"
    # Browsers live outside the repository cache, so cleaning leaves them shared.
    assert paths.browser_root.is_dir()


def test_browser_root_defaults_to_the_shared_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resolve browsers to the shared cache, honoring an explicit override."""
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "explicit"))
    override_paths = runtime.RuntimePaths.from_repo(tmp_path)
    assert override_paths.browser_root == tmp_path / "explicit"

    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    shared_paths = runtime.RuntimePaths.from_repo(tmp_path)
    assert shared_paths.browser_root == tmp_path / "home" / ".cache" / "ms-playwright"
    # The shared browsers are never placed under the repository-local cache.
    assert not runtime.is_within(shared_paths.browser_root, shared_paths.cache_root)


def test_run_in_runtime_propagates_the_child_exit_status(tmp_path: Path) -> None:
    """Return the exact status from a wrapped command."""
    paths = _ready_paths(tmp_path)

    exit_code = runtime.run_in_runtime(
        paths,
        [sys.executable, "-c", "import sys; sys.exit(17)"],
        base={},
    )

    assert exit_code == 17


def test_download_and_extract_uses_only_approved_package_commands(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Download with apt and extract with dpkg-deb without invoking installation."""
    commands: list[list[str]] = []

    def fake_checked_run(
        command: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        del env
        command_list = list(command)
        commands.append(command_list)
        assert cwd is not None
        if command_list[0] == "apt":
            (cwd / "libdemo0_1.0_amd64.deb").write_bytes(b"archive")
        elif command_list[:2] == ["dpkg-deb", "-x"]:
            extracted = Path(command_list[-1])
            library = extracted / "usr" / "lib" / "x86_64-linux-gnu" / "libdemo.so.1"
            library.parent.mkdir(parents=True, exist_ok=True)
            library.write_bytes(b"library")
        return subprocess.CompletedProcess(command_list, 0, "")

    monkeypatch.setattr(runtime, "checked_run", fake_checked_run)

    extracted_root = runtime.download_and_extract(
        [runtime.PackageVersion(name="libdemo0", version="1.0")],
        tmp_path,
    )

    assert (extracted_root / "usr/lib/x86_64-linux-gnu/libdemo.so.1").is_file()
    assert not list((tmp_path / "debs").glob("*.deb"))
    assert [command[0] for command in commands] == ["apt", "dpkg-deb"]
    assert "download" in commands[0]
    assert commands[1][:2] == ["dpkg-deb", "-x"]


def test_remove_stale_staging_deletes_only_owned_stage_directories(tmp_path: Path) -> None:
    """Clear archives abandoned by an interrupted setup and keep other cache files."""
    paths = runtime.RuntimePaths.from_repo(tmp_path)
    runtime.ensure_cache_root(paths)
    stale = paths.cache_root / ".stage-abandoned"
    stale.mkdir()
    (stale / "archive.deb").write_bytes(b"archive")
    marker = paths.cache_root / "keep.txt"
    marker.write_text("keep", encoding="utf-8")

    runtime.remove_stale_staging(paths)

    assert not stale.exists()
    assert marker.read_text(encoding="utf-8") == "keep"


def test_patch_webkit_launchers_preserves_inherited_private_libraries(tmp_path: Path) -> None:
    """Patch only the private launcher and keep the browser wrapper executable."""
    paths = runtime.RuntimePaths.from_repo(tmp_path, browser_root=tmp_path / "shared-browsers")
    launcher = paths.browser_root / "webkit-test" / "minibrowser-wpe" / "MiniBrowser"
    launcher.parent.mkdir(parents=True)
    launcher.write_text(
        f"#!/bin/sh\n{runtime.WEBKIT_LAUNCHER_LD_LINE}\n",
        encoding="utf-8",
    )
    launcher.chmod(0o755)

    runtime.patch_webkit_launchers(paths)
    first_content = launcher.read_text(encoding="utf-8")
    runtime.patch_webkit_launchers(paths)

    assert runtime.WEBKIT_LAUNCHER_LOCAL_LD_LINE in first_content
    assert launcher.read_text(encoding="utf-8") == first_content
    assert launcher.stat().st_mode & stat.S_IXUSR
