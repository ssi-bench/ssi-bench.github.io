from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _strip_bom(text: str) -> str:
    return text.lstrip("\ufeff")


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _parse_scalar(raw: str):
    raw = raw.strip()
    if raw == "":
        return ""
    if raw.lower() in {"null", "none", "~"}:
        return None
    if raw.lower() == "true":
        return True
    if raw.lower() == "false":
        return False
    if re.fullmatch(r"-?\d+", raw):
        try:
            return int(raw)
        except Exception:
            return raw
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        q = raw[0]
        inner = raw[1:-1]
        if q == '"':
            inner = inner.replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\")
        return inner
    return raw


def _preprocess_lines(text: str) -> list[str]:
    lines = []
    for raw in _strip_bom(text).splitlines():
        if not raw.strip():
            continue
        if raw.lstrip().startswith("#"):
            continue
        # Inline comments are not supported; keep line as-is.
        lines.append(raw.rstrip("\r\n"))
    return lines


def _parse_block(lines: list[str], i: int, indent: int):
    if i >= len(lines):
        return None, i

    while i < len(lines) and (not lines[i].strip() or lines[i].lstrip().startswith("#")):
        i += 1
    if i >= len(lines):
        return None, i

    if _indent_of(lines[i]) < indent:
        return None, i

    is_list = lines[i].lstrip().startswith("- ") and _indent_of(lines[i]) == indent

    if is_list:
        out: list = []
        while i < len(lines):
            line = lines[i]
            if _indent_of(line) != indent or not line.lstrip().startswith("- "):
                break
            payload = line.lstrip()[2:].strip()
            if payload == "":
                next_i = i + 1
                next_indent = None
                for j in range(next_i, len(lines)):
                    if not lines[j].strip() or lines[j].lstrip().startswith("#"):
                        continue
                    next_indent = _indent_of(lines[j])
                    break
                if next_indent is None or next_indent <= indent:
                    out.append(None)
                    i += 1
                    continue
                item, i = _parse_block(lines, next_i, next_indent)
                out.append(item)
                continue

            if ":" in payload and not payload.startswith(('"', "'")):
                # Support "- key: value" form (single-line mapping).
                key, rest = payload.split(":", 1)
                key = key.strip()
                rest = rest.lstrip()
                out.append({key: _parse_scalar(rest)})
                i += 1
                continue

            out.append(_parse_scalar(payload))
            i += 1
        return out, i

    out_dict: dict[str, object] = {}
    while i < len(lines):
        line = lines[i]
        if _indent_of(line) != indent:
            break
        if line.lstrip().startswith("- "):
            break
        stripped = line.strip()
        if ":" not in stripped:
            raise ValueError(f"Invalid YAML line (expected key: value): {line!r}")
        key, rest = stripped.split(":", 1)
        key = key.strip()
        rest = rest.lstrip()
        if rest == "":
            next_i = i + 1
            next_indent = None
            for j in range(next_i, len(lines)):
                if not lines[j].strip() or lines[j].lstrip().startswith("#"):
                    continue
                next_indent = _indent_of(lines[j])
                break
            if next_indent is None or next_indent <= indent:
                out_dict[key] = None
                i += 1
                continue
            val, i = _parse_block(lines, next_i, next_indent)
            out_dict[key] = val
            continue
        out_dict[key] = _parse_scalar(rest)
        i += 1
    return out_dict, i


def parse_simple_yaml(text: str) -> dict:
    lines = _preprocess_lines(text)
    if not lines:
        return {}
    root_indent = _indent_of(lines[0])
    obj, _ = _parse_block(lines, 0, root_indent)
    if obj is None:
        return {}
    if not isinstance(obj, dict):
        raise ValueError("Top-level YAML must be a mapping (dict).")
    return obj


def _norm_rel(rel: str) -> Path:
    raw = str(rel or "").strip().strip("/\\")
    raw = raw.replace("\\", "/")
    return Path(*[p for p in raw.split("/") if p])


def _ignore_copytree(src: str, names: list[str]) -> set[str]:
    ignored = set()
    for name in names:
        if name == "__pycache__":
            ignored.add(name)
        if name.endswith(".pyc"):
            ignored.add(name)
        if name in {".DS_Store", "Thumbs.db"}:
            ignored.add(name)
    return ignored


def _copy_tree(src: Path, dst: Path) -> None:
    if not src.is_dir():
        raise SystemExit(f"Expected directory but not found: {src}")
    # Avoid preserving mtime from source so browsers / rebuild triggers see updates reliably.
    shutil.copytree(src, dst, dirs_exist_ok=True, ignore=_ignore_copytree, copy_function=shutil.copy)


def _copy_file(src: Path, dst: Path) -> None:
    if not src.is_file():
        raise SystemExit(f"Expected file but not found: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    # Avoid preserving mtime from source so browsers / rebuild triggers see updates reliably.
    shutil.copy(src, dst)


def _rmtree(path: Path) -> None:
    if not path.exists():
        return
    shutil.rmtree(path)


def _resolve_repo_path(p: str) -> Path:
    return (REPO_ROOT / p).resolve()


def load_config(config_path: Path) -> dict:
    if not config_path.is_file():
        raise SystemExit(f"Config not found: {config_path}")
    data = parse_simple_yaml(config_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit("Invalid config: expected a mapping at top level.")
    return data


def _as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        out = []
        for v in value:
            if v is None:
                continue
            out.append(str(v))
        return out
    return [str(value)]


def sync_benchmark_from_config(config_path: Path, *, dry_run: bool = False) -> None:
    cfg = load_config(config_path)
    src_cfg = cfg.get("source") or {}
    if not isinstance(src_cfg, dict):
        raise SystemExit("Invalid config: `source` must be a mapping.")

    src_benchmark_dir = src_cfg.get("benchmark_dir") or src_cfg.get("benchmarkDir") or cfg.get("benchmark_dir")
    if not src_benchmark_dir:
        raise SystemExit("Config missing `source.benchmark_dir`.")

    src_benchmark = Path(os.path.expandvars(str(src_benchmark_dir))).expanduser().resolve()
    if not src_benchmark.is_dir():
        raise SystemExit(f"source.benchmark_dir not found: {src_benchmark}")

    taxonomy_name = str(src_cfg.get("taxonomy") or "taxonomy.json")
    prompts_name = str(src_cfg.get("prompts_py") or src_cfg.get("promptsPy") or "prompts.py")
    src_taxonomy = (src_benchmark / taxonomy_name).resolve()
    src_prompts = (src_benchmark / prompts_name).resolve()

    include_cfg = cfg.get("include") or {}
    if include_cfg is None:
        include_cfg = {}
    if not isinstance(include_cfg, dict):
        raise SystemExit("Invalid config: `include` must be a mapping.")

    tasks = [_norm_rel(x) for x in _as_list(include_cfg.get("tasks"))]
    items = [_norm_rel(x) for x in _as_list(include_cfg.get("items"))]
    globs = _as_list(include_cfg.get("globs"))

    include_all = not tasks and not items and not globs

    tmp = REPO_ROOT / "benchmark.__sync_tmp__"
    dst_benchmark = REPO_ROOT / "benchmark"

    actions: list[str] = []
    actions.append(f"Source: {src_benchmark}")
    actions.append(f"Target: {dst_benchmark}")
    actions.append(f"Mode: {'all' if include_all else 'filtered'}")

    if dry_run:
        print("\n".join(actions))
        if not include_all:
            if tasks:
                print("Include tasks:")
                for t in tasks:
                    print(f"  - {t.as_posix()}")
            if items:
                print("Include items:")
                for it in items:
                    print(f"  - {it.as_posix()}")
            if globs:
                print("Include globs:")
                for g in globs:
                    print(f"  - {g}")
        return

    _rmtree(tmp)
    tmp.mkdir(parents=True, exist_ok=True)

    # Always refresh taxonomy/prompts from source.
    _copy_file(src_taxonomy, tmp / "taxonomy.json")
    _copy_file(src_prompts, tmp / "prompts.py")

    if include_all:
        for entry in src_benchmark.iterdir():
            if entry.name in {"taxonomy.json", "prompts.py", "__pycache__"}:
                continue
            if entry.is_dir():
                _copy_tree(entry, tmp / entry.name)
        # Note: we intentionally do not copy miscellaneous files beyond taxonomy/prompts.
    else:
        for rel_task in tasks:
            _copy_tree(src_benchmark / rel_task, tmp / rel_task)
        for rel_item in items:
            _copy_tree(src_benchmark / rel_item, tmp / rel_item)
        for pattern in globs:
            pat = str(pattern).replace("\\", "/").lstrip("/").rstrip("/")
            for match in src_benchmark.glob(pat):
                rel = match.relative_to(src_benchmark)
                if match.is_dir():
                    _copy_tree(match, tmp / rel)
                elif match.is_file():
                    _copy_file(match, tmp / rel)

    # Replace benchmark/ atomically-ish.
    _rmtree(dst_benchmark)
    shutil.move(str(tmp), str(dst_benchmark))

    # Refresh derived JSON files.
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "build_prompts.py"),
            "--out",
            str(_resolve_repo_path("data/prompts.json")),
        ],
        cwd=str(REPO_ROOT),
        check=True,
    )
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "build_index.py"),
            "--images-root",
            str(_resolve_repo_path("benchmark")),
            "--taxonomy",
            str(_resolve_repo_path("benchmark/taxonomy.json")),
            "--out",
            str(_resolve_repo_path("data/index.json")),
            "--web-images-prefix",
            "benchmark",
            "--sync-config",
            str(config_path),
        ],
        cwd=str(REPO_ROOT),
        check=True,
    )

    print("Synced benchmark/, refreshed data/index.json and data/prompts.json.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync benchmark/ from an external dataset folder using YAML config.")
    parser.add_argument("--config", default="dataset_sync.yaml", help="Path to YAML config (default: dataset_sync.yaml).")
    parser.add_argument("--dry-run", action="store_true", help="Print what would happen, without copying/deleting.")
    args = parser.parse_args()

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = (REPO_ROOT / config_path).resolve()
    sync_benchmark_from_config(config_path, dry_run=bool(args.dry_run))


if __name__ == "__main__":
    main()
