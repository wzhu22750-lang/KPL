"""Read-only dataset preparation, quality evaluation and shadow runs. No collection or admission."""

import argparse
import asyncio
import hashlib
import json
import os
from collections import Counter
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup

from curator import assess_article
from quality_scoring import (
    PROMPT_PATH,
    QUALITY_THRESHOLD,
    SCORING_VERSION,
    QualityScoringError,
    content_fingerprint,
    quality_passes,
    score_article,
)

ROOT = Path(__file__).resolve().parent
PROTECTED = (ROOT / "kpl_vault", ROOT / "kpl_articles")


class DatasetError(ValueError):
    pass


def digest(value: Any) -> str:
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def output_allowed(path: Path, protected: tuple[Path, ...] = PROTECTED):
    resolved = path.resolve()
    if any(resolved == root.resolve() or root.resolve() in resolved.parents for root in protected):
        raise DatasetError("评测产物不得写入文章源目录或kpl_vault")


def write_jsonl(path: Path, rows: list[dict[str, Any]]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def prepare_dataset(roots: list[Path], output: Path, *, limit: int = 150) -> dict[str, Any]:
    """Export unlabeled local material, grouping exact copies into the same split."""
    output_allowed(output, (*PROTECTED, *roots))
    if output.exists():
        raise DatasetError("标注文件已存在，拒绝覆盖人工标签")
    if limit < 1:
        raise DatasetError("limit必须为正整数")
    rows, errors = [], []
    urls: set[str] = set()
    owners: dict[str, str] = {}
    paths = sorted({path.resolve() for root in roots for path in root.rglob("metadata.json")})
    for path in paths:
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
            url = meta["source_url"]
            title = meta["title"]
            if not isinstance(url, str) or not url or not isinstance(title, str) or not title:
                raise DatasetError("缺少有效标题或来源URL")
            if url in urls:
                continue
            html_path = path.parent / "offline.html"
            text = ""
            body_source = "offline_html"
            if html_path.exists():
                soup = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html.parser")
                body = soup.select_one(".content") or soup.select_one("#js_content")
                if body:
                    for node in body.select("script, style, img, svg, video, audio"):
                        node.decompose()
                    text = body.get_text().strip()
            if not text:
                md_path = (path.parent / meta["markdown_file"]).resolve()
                if not md_path.is_relative_to(path.parent):
                    raise DatasetError("Markdown路径越界")
                text = md_path.read_text(encoding="utf-8").strip()
                body_source = "markdown_fallback_needs_review"
            if not text:
                raise DatasetError("正文为空")
            fingerprint = content_fingerprint(text)
            row = {
                "case_id": "local-" + digest(url)[:16],
                "split": "holdout" if int(fingerprint[:8], 16) % 5 == 0 else "development",
                "split_group": fingerprint,
                "material": {"title": title, "author": str(meta.get("author") or ""), "text": text,
                             "source_url": url, "publish_time": str(meta.get("publish_time") or ""),
                             "duplicate": fingerprint in owners and owners[fingerprint] != url},
                "gold": {"decision": None, "reviewer": "", "reason": "", "content_category": None},
                "sampling": {"origin": str(path), "body_source": body_source,
                             "warning": "本地库样本不代表全部候选；需补充拒绝稿、短BP及噪声难例"},
            }
            urls.add(url)
            owners[fingerprint] = url
            rows.append(row)
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append({"path": str(path), "error_type": type(error).__name__})
    rows.sort(key=lambda row: row["case_id"])
    rows = rows[:limit]
    if not rows:
        raise DatasetError("未找到可用本地文章，不生成空标注集")
    write_jsonl(output, rows)
    return {"exported": len(rows), "available": len(urls), "unlabeled": len(rows),
            "splits": dict(Counter(row["split"] for row in rows)), "read_errors": errors}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError()
        except ValueError:
            raise DatasetError(f"JSONL第{line_number}行不是合法JSON对象") from None
        rows.append(row)
    return rows


def validate_dataset(rows: list[dict[str, Any]]):
    ids: set[str] = set()
    groups: dict[str, str] = {}
    for row in rows:
        case_id = row.get("case_id")
        if not isinstance(case_id, str) or not case_id or case_id in ids:
            raise DatasetError("case_id必须非空且唯一")
        ids.add(case_id)
        split = row.get("split")
        if split not in {"development", "holdout"}:
            raise DatasetError(f"{case_id}: split非法")
        material = row.get("material")
        if not isinstance(material, dict):
            raise DatasetError(f"{case_id}: 缺少material")
        required = {"title", "author", "text", "source_url", "publish_time", "duplicate"}
        if set(material) != required:
            raise DatasetError(f"{case_id}: material字段不符合契约")
        if any(not isinstance(material[key], str) for key in required - {"duplicate"}):
            raise DatasetError(f"{case_id}: material文本类型非法")
        if not material["text"].strip() or type(material["duplicate"]) is not bool:
            raise DatasetError(f"{case_id}: 正文或duplicate非法")
        gold = row.get("gold")
        if not isinstance(gold, dict) or gold.get("decision") not in {None, "select", "reject", "either"}:
            raise DatasetError(f"{case_id}: 人工标签非法")
        if gold.get("decision") is not None and not str(gold.get("reviewer") or "").strip():
            raise DatasetError(f"{case_id}: 已标注样本必须填写reviewer")
        # Exact-copy and user-specified event groups both must stay within one split.
        for group in (content_fingerprint(material["text"]), row.get("split_group")):
            if group is None:
                continue
            if not isinstance(group, str) or not group:
                raise DatasetError(f"{case_id}: split_group非法")
            if group in groups and groups[group] != split:
                raise DatasetError("相同正文/事件组跨开发集与留出集，存在数据泄漏")
            groups[group] = split


def metrics(results: list[dict[str, Any]], *, threshold: int = QUALITY_THRESHOLD) -> dict[str, Any]:
    counts = dict.fromkeys(("tp", "fp", "tn", "fn"), 0)
    evaluated = 0
    total_binary = sum(row["gold"].get("decision") in {"select", "reject"} for row in results)
    for row in results:
        gold = row["gold"].get("decision")
        if gold not in {"select", "reject"} or row["status"] == "pending_review":
            continue
        quality = row["quality"]
        predicted = bool(quality and quality_passes(
            quality["quality_score"], quality["dimensions"], quality["content_category"],
            threshold=threshold, duplicate=row["duplicate"],
        ))
        key = "tp" if gold == "select" and predicted else "fn" if gold == "select" else "fp" if predicted else "tn"
        counts[key] += 1
        evaluated += 1
    tp, fp, tn, fn = (counts[key] for key in ("tp", "fp", "tn", "fn"))
    attempts = sum(row["model_attempted"] for row in results)
    successes = sum(row["quality"] is not None and row["model_attempted"] for row in results)
    return {
        **counts, "binary_labeled": total_binary, "evaluated": evaluated,
        "pending": sum(row["status"] == "pending_review" for row in results),
        "unlabeled": sum(row["gold"].get("decision") is None for row in results),
        "coverage": evaluated / total_binary if total_binary else None,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "accuracy": (tp + tn) / evaluated if evaluated else None,
        "model_attempts": attempts, "model_valid_outputs": successes,
        "model_failure_rate": (attempts - successes) / attempts if attempts else None,
    }


async def evaluate_dataset(
    rows: list[dict[str, Any]], *, scorer: Callable[..., Awaitable[dict[str, Any]]] | None = None,
    replay: list[dict[str, Any]] | None = None, max_calls: int = 20, evaluated_at: str | None = None,
) -> dict[str, Any]:
    """Score local materials only; no scraper, vault writes, database or publication calls."""
    validate_dataset(rows)
    if max_calls < 1:
        raise DatasetError("max_calls必须为正整数")
    if scorer is not None and replay is not None:
        raise DatasetError("真实评分与回放不能同时使用")
    prompt_hash = hashlib.sha256(PROMPT_PATH.read_bytes()).hexdigest()
    now = evaluated_at or datetime.now(UTC).isoformat()
    replay_by_id = {}
    for record in replay or []:
        case_id = record.get("case_id")
        if not isinstance(case_id, str) or case_id in replay_by_id:
            raise DatasetError("回放case_id非法或重复")
        replay_by_id[case_id] = record
    results = []
    calls = 0
    for row in rows:
        raw = None
        attempted = False
        record = replay_by_id.get(row["case_id"])
        scoring_time = record.get("evaluated_at", now) if record else now
        if not isinstance(scoring_time, str):
            raise DatasetError("回放时间格式非法")

        async def evaluate_one(**material):
            nonlocal raw, attempted, calls
            if replay is not None:
                if (not record or record.get("material_digest") != digest(row["material"])
                        or record.get("prompt_hash") != prompt_hash or record.get("version") != SCORING_VERSION):
                    raise QualityScoringError("回放缺失或正文/Prompt/版本不匹配，待复核")
                attempted = True
                raw = record.get("raw_result")
                return raw
            if scorer is None:
                raise QualityScoringError("影子运行未启用模型，仅检查规则和数据契约")
            if calls >= max_calls:
                raise QualityScoringError("影子运行模型调用次数预算耗尽，待复核")
            calls += 1
            attempted = True
            raw = await scorer(**material)
            return raw

        decision = await assess_article(**row["material"], scorer=evaluate_one, evaluated_at=scoring_time)
        quality = decision["quality"]
        expected = row["gold"].get("decision")
        predicted = decision["status"] == "passed"
        error = None
        if decision["status"] != "pending_review":
            if expected == "select" and not predicted:
                error = "false_negative"
            elif expected == "reject" and predicted:
                error = "false_positive"
        results.append({
            "case_id": row["case_id"], "split": row["split"], "title": row["material"]["title"],
            "gold": row["gold"], "duplicate": row["material"]["duplicate"],
            "status": decision["status"], "reason": decision["reason"], "quality": quality,
            "error": error, "model_attempted": attempted, "raw_result": raw,
            "evaluated_at": scoring_time, "material_digest": digest(row["material"]),
            "prompt_hash": prompt_hash, "version": SCORING_VERSION,
        })
    by_category = {}
    for category in sorted({row["quality"]["content_category"] for row in results if row["quality"]}):
        by_category[category] = metrics([row for row in results if row["quality"]
                                         and row["quality"]["content_category"] == category])
    split_names = sorted({row["split"] for row in rows})
    return {
        "mode": "replay" if replay is not None else "live_shadow" if scorer else "disabled_shadow",
        "version": SCORING_VERSION, "prompt_hash": prompt_hash, "evaluated_at": now,
        "dataset_digest": digest(rows), "production_threshold": QUALITY_THRESHOLD,
        "metrics": metrics(results), "by_category": by_category,
        "by_split": {split: metrics([row for row in results if row["split"] == split]) for split in split_names},
        # Never tune on holdout. Report its fixed production policy only.
        "development_threshold_sweep": [
            {"threshold": threshold, **metrics([row for row in results if row["split"] == "development"],
                                               threshold=threshold)} for threshold in range(50, 91, 5)
        ],
        "results": results,
    }


def save_report(report: dict[str, Any], output: Path, *, protected: tuple[Path, ...] = PROTECTED):
    output_allowed(output, protected)
    output.mkdir(parents=True, exist_ok=False)
    write_jsonl(output / "results.jsonl", report["results"])
    summary = {key: value for key, value in report.items() if key != "results"}
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# AI 精选影子评测", "", f"模式：{report['mode']}；生产阈值：{QUALITY_THRESHOLD}",
             "", "注意：无人工标签时不计算准确率；失败待复核不当作低质拒绝。回放不能证明真实模型准确率。",
             "", "```json", json.dumps(summary["metrics"], ensure_ascii=False, indent=2), "```", "",
             "## 误选/漏选及待复核", ""]
    for row in report["results"]:
        if row["error"] or row["status"] == "pending_review":
            # Encode untrusted title/reason rather than allowing injected Markdown tables/links.
            lines.append(json.dumps({key: row[key] for key in ("case_id", "title", "error", "status", "reason")},
                                    ensure_ascii=False))
    (output / "report.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare", help="从本地文章生成无标签数据集")
    prepare.add_argument("--root", action="append", type=Path, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    prepare.add_argument("--limit", type=int, default=150)
    for command in ("evaluate", "shadow"):
        action = sub.add_parser(command)
        action.add_argument("--dataset", type=Path, required=True)
        action.add_argument("--output", type=Path, required=True)
        action.add_argument("--split", choices=("development", "holdout", "all"), default="development")
        action.add_argument("--limit", type=int, default=20)
        action.add_argument("--max-calls", type=int, default=20)
        mode = action.add_mutually_exclusive_group(required=command == "evaluate")
        mode.add_argument("--replay", type=Path)
        mode.add_argument("--live", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            summary = prepare_dataset(args.root, args.output, limit=args.limit)
        else:
            if args.limit < 1 or args.max_calls < 1:
                raise DatasetError("limit和max_calls必须为正整数")
            output_allowed(args.output)
            if args.output.exists() or args.dataset.resolve().is_relative_to(args.output.resolve()):
                raise DatasetError("输出目录已存在或包含标注数据，拒绝覆盖")
            rows = read_jsonl(args.dataset)
            validate_dataset(rows)  # Check leakage before filtering split/limit.
            rows = [row for row in rows if args.split == "all" or row["split"] == args.split][:args.limit]
            if not rows:
                raise DatasetError("当前split没有可评测样本")
            if args.command == "evaluate" and not any(row["gold"].get("decision") in {"select", "reject"} for row in rows):
                raise DatasetError("evaluate需要人工二元标签；无标签请用shadow")
            if args.live and (os.getenv("KPL_QUALITY_MODEL_CALLS_ENABLED") != "true" or not all(
                os.getenv(key) for key in ("KPL_QUALITY_API_BASE", "KPL_QUALITY_MODEL", "KPL_QUALITY_API_KEY")
            )):
                raise DatasetError("live需要显式启用模型并提供完整环境配置")
            replay = read_jsonl(args.replay) if args.replay else None
            report = asyncio.run(evaluate_dataset(rows, scorer=score_article if args.live else None,
                                                 replay=replay, max_calls=args.max_calls))
            save_report(report, args.output)
            summary = {"output": str(args.output), "mode": report["mode"], "metrics": report["metrics"]}
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    except (DatasetError, OSError) as error:
        parser.exit(2, f"评测未执行：{error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
