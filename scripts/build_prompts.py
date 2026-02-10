from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PROMPTS_SRC = REPO_ROOT / "benchmark" / "prompts.py"


def load_prompts_by_task_slug():
    if not PROMPTS_SRC.is_file():
        raise SystemExit(f"prompts.py not found: {PROMPTS_SRC}")

    spec = importlib.util.spec_from_file_location("ssi_bench_prompts", PROMPTS_SRC)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Failed to import prompts module from: {PROMPTS_SRC}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    fn = getattr(module, "prompts_by_task_slug", None)
    if not callable(fn):
        raise SystemExit(f"`prompts_by_task_slug()` not found in: {PROMPTS_SRC}")
    return fn


def main() -> None:
    parser = argparse.ArgumentParser(description="Export prompt templates to JSON for the web viewer.")
    parser.add_argument("--out", default="data/prompts.json", help="Output path for prompts.json")
    args = parser.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    prompts_by_task_slug = load_prompts_by_task_slug()

    base = prompts_by_task_slug()
    multi_view = prompts_by_task_slug(multi_view=True)
    payload = {
        **base,
        **{f"mv_{slug}": template for slug, template in multi_view.items()},
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
