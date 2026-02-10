from __future__ import annotations

import argparse
import base64
import getpass
import os
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def _maybe_rebuild_leaderboards(server: ThreadingHTTPServer, *, force: bool = False) -> None:
    auto = bool(getattr(server, "auto_build_leaderboards", False))
    if not auto and not force:
        return

    root: Path | None = getattr(server, "repo_root", None)
    if not root:
        return

    builder = root / "scripts" / "build_leaderboard.py"
    if not builder.exists():
        return

    xlsx_pairs = [
        (root / "data" / "pairwise_acc.xlsx", root / "data" / "pairwise_acc.json"),
        (root / "data" / "task_acc.xlsx", root / "data" / "task_acc.json"),
    ]
    present = [(src, out) for src, out in xlsx_pairs if src.exists()]
    if not present:
        return

    try:
        src_mtime = max([builder.stat().st_mtime, *[src.stat().st_mtime for src, _ in present]])
    except OSError:
        return

    last_src_mtime = float(getattr(server, "_last_leaderboards_src_mtime", 0.0))
    if not force and src_mtime <= last_src_mtime:
        return

    lock: threading.Lock | None = getattr(server, "_leaderboards_build_lock", None)
    if lock is None:
        lock = threading.Lock()
        server._leaderboards_build_lock = lock

    if not lock.acquire(blocking=False):
        return
    try:
        try:
            src_mtime2 = max([builder.stat().st_mtime, *[src.stat().st_mtime for src, _ in present]])
        except OSError:
            return

        last_src_mtime2 = float(getattr(server, "_last_leaderboards_src_mtime", 0.0))
        if not force and src_mtime2 <= last_src_mtime2:
            return

        for src, out in present:
            cmd = [sys.executable, str(builder), "--xlsx", str(src.relative_to(root)), "--out", str(out.relative_to(root))]
            subprocess.run(cmd, cwd=str(root), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)

        server._last_leaderboards_src_mtime = src_mtime2
        server._last_leaderboards_build_at = time.time()
    finally:
        lock.release()


class BasicAuthHandler(SimpleHTTPRequestHandler):
    server_version = "SSIAuthHTTP/1.0"

    def end_headers(self) -> None:
        disable_cache = bool(getattr(self.server, "disable_cache", True))
        if disable_cache:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_HEAD(self) -> None:  # noqa: N802
        self._maybe_rebuild_prompts()
        self._maybe_rebuild_index()
        _maybe_rebuild_leaderboards(self.server)
        if not self._is_authorized():
            self._send_unauthorized()
            return
        super().do_HEAD()

    def do_GET(self) -> None:  # noqa: N802
        self._maybe_rebuild_prompts()
        self._maybe_rebuild_index()
        _maybe_rebuild_leaderboards(self.server)
        if not self._is_authorized():
            self._send_unauthorized()
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        self._maybe_rebuild_prompts()
        self._maybe_rebuild_index()
        _maybe_rebuild_leaderboards(self.server)
        if not self._is_authorized():
            self._send_unauthorized()
            return
        super().do_POST()

    def _latest_mtime_under(self, root: Path, allowed_suffixes: set[str]) -> float:
        if not root.exists():
            return 0.0

        latest = 0.0
        stack: list[Path] = [root]
        while stack:
            cur = stack.pop()
            try:
                with os.scandir(cur) as it:
                    for entry in it:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(Path(entry.path))
                                continue
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            if allowed_suffixes and Path(entry.name).suffix.lower() not in allowed_suffixes:
                                continue
                            mtime = entry.stat(follow_symlinks=False).st_mtime
                            if mtime > latest:
                                latest = mtime
                        except OSError:
                            continue
            except OSError:
                continue

        return latest

    def _maybe_rebuild_prompts(self) -> None:
        auto = bool(getattr(self.server, "auto_build_prompts", False))
        if not auto:
            return

        root: Path | None = getattr(self.server, "repo_root", None)
        if not root:
            return

        src = root / "benchmark" / "prompts.py"
        out = root / "data" / "prompts.json"
        builder = root / "scripts" / "build_prompts.py"
        if not src.exists() or not builder.exists():
            return

        try:
            src_mtime = src.stat().st_mtime
        except OSError:
            return

        last_src_mtime = float(getattr(self.server, "_last_prompts_src_mtime", 0.0))
        if src_mtime <= last_src_mtime:
            return

        lock: threading.Lock | None = getattr(self.server, "_prompts_build_lock", None)
        if lock is None:
            lock = threading.Lock()
            self.server._prompts_build_lock = lock

        if not lock.acquire(blocking=False):
            return
        try:
            src_mtime2 = src.stat().st_mtime
            last_src_mtime2 = float(getattr(self.server, "_last_prompts_src_mtime", 0.0))
            if src_mtime2 <= last_src_mtime2:
                return

            cmd = [sys.executable, str(builder), "--out", str(out)]
            subprocess.run(cmd, cwd=str(root), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            self.server._last_prompts_src_mtime = src_mtime2
            self.server._last_prompts_build_at = time.time()
        finally:
            lock.release()

    def _maybe_rebuild_index(self) -> None:
        auto = bool(getattr(self.server, "auto_build_index", False))
        if not auto:
            return

        root: Path | None = getattr(self.server, "repo_root", None)
        if not root:
            return

        images_root = root / "benchmark"
        taxonomy_path = root / "benchmark" / "taxonomy.json"
        out = root / "data" / "index.json"
        builder = root / "scripts" / "build_index.py"
        if not images_root.exists() or not taxonomy_path.exists() or not builder.exists():
            return

        allowed_suffixes = {".jpg", ".json", ".txt"}
        try:
            latest_benchmark_mtime = self._latest_mtime_under(images_root, allowed_suffixes)
            src_mtime = max(latest_benchmark_mtime, taxonomy_path.stat().st_mtime, builder.stat().st_mtime)
        except OSError:
            return

        last_src_mtime = float(getattr(self.server, "_last_index_src_mtime", 0.0))
        if src_mtime <= last_src_mtime:
            return

        lock: threading.Lock | None = getattr(self.server, "_index_build_lock", None)
        if lock is None:
            lock = threading.Lock()
            self.server._index_build_lock = lock

        if not lock.acquire(blocking=False):
            return
        try:
            try:
                latest_benchmark_mtime2 = self._latest_mtime_under(images_root, allowed_suffixes)
                src_mtime2 = max(latest_benchmark_mtime2, taxonomy_path.stat().st_mtime, builder.stat().st_mtime)
            except OSError:
                return

            last_src_mtime2 = float(getattr(self.server, "_last_index_src_mtime", 0.0))
            if src_mtime2 <= last_src_mtime2:
                return

            cmd = [
                sys.executable,
                str(builder),
                "--images-root",
                str(images_root.relative_to(root)),
                "--taxonomy",
                str(taxonomy_path.relative_to(root)),
                "--out",
                str(out.relative_to(root)),
                "--web-images-prefix",
                "benchmark",
            ]
            subprocess.run(cmd, cwd=str(root), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            self.server._last_index_src_mtime = src_mtime2
            self.server._last_index_build_at = time.time()
        finally:
            lock.release()

    def _send_unauthorized(self) -> None:
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", f'Basic realm="{self.server.auth_realm}"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"401 Unauthorized\n")

    def _is_authorized(self) -> bool:
        expected_user = getattr(self.server, "auth_user", "")
        expected_pass = getattr(self.server, "auth_pass", "")
        if not expected_pass:
            return True

        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            raw = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
        except Exception:
            return False
        user, sep, passwd = raw.partition(":")
        if sep != ":":
            return False
        return user == expected_user and passwd == expected_pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Static file server with optional HTTP Basic Auth (useful for LAN preview)."
    )
    parser.add_argument("--bind", default="127.0.0.1", help="Bind address (use 0.0.0.0 for LAN).")
    parser.add_argument("--port", type=int, default=8000, help="Port to serve on.")
    parser.add_argument("--user", default="viewer", help="Basic-auth username.")
    parser.add_argument("--password", default="", help="Basic-auth password (leave empty to disable auth).")
    parser.add_argument(
        "--prompt-password",
        action="store_true",
        help="Prompt for password (recommended instead of passing --password in shell history).",
    )
    parser.add_argument("--realm", default="SSI-Bench LAN Preview", help="Basic-auth realm.")
    parser.add_argument(
        "--no-auto-build-prompts",
        action="store_true",
        help="Disable auto-regenerating data/prompts.json when benchmark/prompts.py changes.",
    )
    parser.add_argument(
        "--no-auto-build-index",
        action="store_true",
        help="Disable auto-regenerating data/index.json when benchmark/ content changes.",
    )
    parser.add_argument(
        "--no-auto-build-leaderboards",
        action="store_true",
        help="Disable auto-regenerating data/pairwise_acc.json and data/task_acc.json when the XLSX files change.",
    )
    parser.add_argument(
        "--sync-config",
        default="",
        help="Optional YAML config to sync benchmark/ before serving (defaults to dataset_sync.yaml if present).",
    )
    parser.add_argument(
        "--no-auto-sync-benchmark",
        action="store_true",
        help="Disable auto-syncing benchmark/ from dataset_sync.yaml when present.",
    )
    parser.add_argument(
        "--cache",
        action="store_true",
        help="Enable HTTP caching headers (default: disable cache for reliable LAN preview refresh).",
    )
    args = parser.parse_args()

    password = args.password
    if args.prompt_password:
        password = getpass.getpass("Password: ")

    repo_root = Path(__file__).resolve().parents[1]
    sync_config = args.sync_config.strip()
    if not args.no_auto_sync_benchmark:
        default_cfg = repo_root / "dataset_sync.yaml"
        if not sync_config and default_cfg.is_file():
            sync_config = str(default_cfg)
    if sync_config:
        cfg_path = Path(sync_config)
        if not cfg_path.is_absolute():
            cfg_path = (repo_root / cfg_path).resolve()
        sync_script = repo_root / "scripts" / "sync_benchmark.py"
        if not sync_script.is_file():
            raise SystemExit(f"sync script not found: {sync_script}")
        if not cfg_path.is_file():
            raise SystemExit(f"sync config not found: {cfg_path}")
        subprocess.run([sys.executable, str(sync_script), "--config", str(cfg_path)], cwd=str(repo_root), check=True)

    httpd = ThreadingHTTPServer((args.bind, args.port), BasicAuthHandler)
    httpd.repo_root = repo_root
    httpd.auth_user = args.user
    httpd.auth_pass = password
    httpd.auth_realm = args.realm
    httpd.auto_build_prompts = not bool(args.no_auto_build_prompts)
    httpd.auto_build_index = not bool(args.no_auto_build_index)
    httpd.auto_build_leaderboards = not bool(args.no_auto_build_leaderboards)
    httpd.disable_cache = not bool(args.cache)

    scheme = "http"
    host = args.bind
    if host == "0.0.0.0":
        host = "<your-ip>"
    print(f"Serving {scheme}://{host}:{args.port}/ (bind={args.bind})")
    if password:
        print(f"Auth enabled (user={args.user}).")
    else:
        print("Auth disabled.")
    print(f"Auto-build prompts: {'on' if httpd.auto_build_prompts else 'off'}.")
    print(f"Auto-build index: {'on' if httpd.auto_build_index else 'off'}.")
    print(f"Auto-build leaderboards: {'on' if httpd.auto_build_leaderboards else 'off'}.")
    print(f"HTTP cache: {'on' if args.cache else 'off'} (off adds no-cache headers).")

    _maybe_rebuild_leaderboards(httpd, force=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
