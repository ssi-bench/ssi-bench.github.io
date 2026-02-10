import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True)
class TaskMeta:
    slug: str
    name: str
    category_slug: str
    category_name: str


def load_taxonomy(taxonomy_path: Path) -> tuple[dict[str, str], dict[str, TaskMeta]]:
    data = json.loads(taxonomy_path.read_text(encoding="utf-8"))
    category_names = {c["slug"]: c["name"] for c in data.get("categories", [])}
    tasks: dict[str, TaskMeta] = {}
    for t in data.get("tasks", []):
        cat_slug = t["categorySlug"]
        tasks[t["slug"]] = TaskMeta(
            slug=t["slug"],
            name=t["name"],
            category_slug=cat_slug,
            category_name=category_names.get(cat_slug, cat_slug),
        )
    return category_names, tasks


def to_posix(path: Path) -> str:
    return path.as_posix()


def find_sample_dirs(images_root: Path, max_depth: int) -> list[Path]:
    found = []
    stack: list[tuple[Path, int]] = [(images_root, 0)]
    while stack:
        cur, depth = stack.pop()
        if depth > max_depth:
            continue
        has_single_view = (cur / "original.jpg").is_file()
        has_multi_view = (cur / "original1.jpg").is_file() and (cur / "original2.jpg").is_file()
        has_meta = (cur / "answer.json").is_file() or (cur / "info.txt").is_file()
        if (has_single_view or has_multi_view) and has_meta:
            found.append(cur)
            continue
        for child in cur.iterdir():
            if child.is_dir():
                stack.append((child, depth + 1))
    return sorted(set(found))


def load_sync_item_order(config_path: Path) -> list[str]:
    if not config_path.is_file():
        return []
    try:
        from sync_benchmark import parse_simple_yaml
    except Exception:
        return []
    try:
        cfg = parse_simple_yaml(config_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(cfg, dict):
        return []
    include_cfg = cfg.get("include")
    if not isinstance(include_cfg, dict):
        return []
    items = include_cfg.get("items")
    if items is None:
        return []
    if isinstance(items, list):
        raw_items = [str(it) for it in items if it is not None]
    else:
        raw_items = [str(items)]
    ordered = []
    for raw in raw_items:
        cleaned = str(raw).strip().strip("/\\").replace("\\", "/")
        if cleaned:
            ordered.append(cleaned)
    return ordered


def order_sample_dirs(sample_dirs: list[Path], images_root: Path, order_list: list[str]) -> list[Path]:
    if not order_list:
        return sample_dirs
    order_index = {key: idx for idx, key in enumerate(order_list)}

    def sort_key(path: Path):
        rel = path.relative_to(images_root).as_posix()
        return (order_index.get(rel, len(order_index)), rel)

    return sorted(sample_dirs, key=sort_key)


def collect_options(task_dir: Path) -> list[dict]:
    options: list[tuple[int, str]] = []
    for p in task_dir.iterdir():
        if not p.is_file():
            continue
        if p.suffix.lower() != ".jpg":
            continue
        stem = p.stem
        if stem.isdigit():
            options.append((int(stem), p.name))
    options.sort(key=lambda x: x[0])
    return [{"label": n, "file": fname} for n, fname in options]


def try_load_answer_json(sample_dir: Path) -> dict | None:
    answer_path = sample_dir / "answer.json"
    if not answer_path.is_file():
        return None
    try:
        return json.loads(answer_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def build_item(
    sample_dir: Path,
    images_root: Path,
    web_images_prefix: str,
    category_name_by_slug: dict[str, str],
    task_meta_by_slug: dict[str, TaskMeta],
) -> dict:
    rel_sample_dir = sample_dir.relative_to(images_root)
    answer_json = try_load_answer_json(sample_dir)

    category_slug: str | None = None
    task_slug: str | None = None
    base_task_slug: str | None = None
    is_multi_view = False
    if isinstance(answer_json, dict):
        taxonomy = answer_json.get("taxonomy")
        if isinstance(taxonomy, dict):
            category_slug = taxonomy.get("categorySlug") or category_slug
            task_slug = taxonomy.get("taskSlug") or task_slug
            base_task_slug = task_slug
            is_multi_view = bool(taxonomy.get("multi_view")) or is_multi_view

    if task_slug is None and len(rel_sample_dir.parts) >= 2:
        task_slug = rel_sample_dir.parts[1]
    if category_slug is None and len(rel_sample_dir.parts) >= 1:
        category_slug = rel_sample_dir.parts[0]

    if task_slug is None:
        task_slug = sample_dir.name

    has_multi_view_originals = (sample_dir / "original1.jpg").is_file() and (sample_dir / "original2.jpg").is_file()
    if has_multi_view_originals:
        is_multi_view = True

    if is_multi_view and category_slug:
        task_slug = f"multi_view_{category_slug}"

    task_meta = task_meta_by_slug.get(task_slug)
    if task_meta is None:
        task_meta = TaskMeta(
            slug=task_slug,
            name=task_slug.replace("_", " ").title(),
            category_slug=category_slug or "other",
            category_name=category_name_by_slug.get(
                category_slug or "other", (category_slug or "Other").replace("_", " ").title()
            ),
        )

    if category_slug is None:
        category_slug = task_meta.category_slug

    category_name = category_name_by_slug.get(category_slug, task_meta.category_name)

    web_dir = f"{web_images_prefix}/{to_posix(rel_sample_dir)}"

    options = collect_options(sample_dir)
    reference = None
    if is_multi_view:
        reference = next((o for o in options if o["label"] == 0), None)
        options = [o for o in options if o["label"] != 0]

    item: dict = {
        "id": to_posix(rel_sample_dir),
        "categorySlug": category_slug,
        "categoryName": category_name,
        "taskSlug": task_slug,
        "taskName": task_meta.name,
        "dir": web_dir,
        "original": f"{web_dir}/original.jpg",
        "options": [{"label": o["label"], "src": f"{web_dir}/{o['file']}"} for o in options],
    }

    if is_multi_view:
        item["isMultiView"] = True
        if base_task_slug:
            item["baseTaskSlug"] = base_task_slug
        if has_multi_view_originals:
            item["originals"] = [f"{web_dir}/original1.jpg", f"{web_dir}/original2.jpg"]
            item["original"] = item["originals"][0]
        if reference:
            item["reference"] = {"label": reference["label"], "src": f"{web_dir}/{reference['file']}"}

    if (sample_dir / "answer.json").is_file():
        item["answer"] = f"{web_dir}/answer.json"
    if (sample_dir / "info.txt").is_file():
        item["info"] = f"{web_dir}/info.txt"

    return item


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a static data/index.json for the SSI-Bench viewer.")
    parser.add_argument(
        "--images-root",
        type=Path,
        default=Path("benchmark"),
        help="Path to benchmark root (contains category/task/sample folders).",
    )
    parser.add_argument(
        "--taxonomy",
        type=Path,
        default=Path("benchmark/taxonomy.json"),
        help="Path to taxonomy.json (used for category/task names).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/index.json"),
        help="Output path for index.json (served by GitHub Pages).",
    )
    parser.add_argument(
        "--web-images-prefix",
        type=str,
        default="benchmark",
        help="Web path prefix (relative to site root) to images root.",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=3,
        help="Max folder depth to scan under images-root to find sample folders.",
    )
    parser.add_argument(
        "--sync-config",
        type=Path,
        default=None,
        help="Optional dataset_sync.yaml to preserve include.items ordering.",
    )
    args = parser.parse_args()

    images_root = args.images_root.resolve()
    taxonomy_path = args.taxonomy
    out_path = args.out

    if not images_root.is_dir():
        raise SystemExit(f"--images-root not found: {images_root}")
    if not taxonomy_path.is_file():
        raise SystemExit(f"--taxonomy not found: {taxonomy_path}")

    category_name_by_slug, task_meta_by_slug = load_taxonomy(taxonomy_path)

    order_list = []
    if args.sync_config:
        order_list = load_sync_item_order(args.sync_config)
    else:
        order_list = load_sync_item_order(Path("dataset_sync.yaml"))

    items = []
    sample_dirs = find_sample_dirs(images_root, max_depth=args.max_depth)
    for sample_dir in order_sample_dirs(sample_dirs, images_root, order_list):
        items.append(
            build_item(
                sample_dir,
                images_root,
                args.web_images_prefix.rstrip("/"),
                category_name_by_slug,
                task_meta_by_slug,
            )
        )

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "imagesRoot": args.web_images_prefix.rstrip("/"),
        "items": items,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} with {len(items)} items.")


if __name__ == "__main__":
    main()
