"""Article-value scoring, separate from the site's event attentionScore."""

import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

SCORING_VERSION = "kpl-quality-v1"
DIMENSIONS = (
    "information_value", "analysis_depth", "originality", "timeliness", "reference_value", "noise_penalty"
)
WEIGHTS = {
    "official_news": (.45, .05, .05, .30, .15),
    "match_report": (.35, .20, .10, .20, .15),
    "tactical_analysis": (.20, .35, .15, .05, .25),
    "player_story": (.25, .20, .20, .10, .25),
    "community_discussion": (.30, .15, .15, .15, .25),
}
QUALITY_THRESHOLD = 70  # Initial editorial policy; calibrate on human-labelled holdouts before rollout.
MAX_BODY_CHARS = 120_000
PROMPT_PATH = Path(__file__).parent / "prompts" / "curation-quality.md"


class QualityScoringError(ValueError):
    """Unavailable or invalid evaluation; must not fall back to keyword admission."""


def content_fingerprint(text: str) -> str:
    normalized = re.sub(r"\s+", "", text).casefold()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def normalize_quality_result(raw: Any, *, duplicate: bool = False) -> dict[str, Any]:
    """Validate model JSON and enforce the local editorial policy (not model booleans)."""
    required = {"quality_score", "dimensions", "content_category", "reason", "should_curate"}
    if not isinstance(raw, dict) or set(raw) != required:
        raise QualityScoringError("评分 JSON 字段不符合契约")
    dims = raw["dimensions"]
    if not isinstance(dims, dict) or set(dims) != set(DIMENSIONS):
        raise QualityScoringError("评分维度不完整")
    for value in [raw["quality_score"], *dims.values()]:
        if type(value) is not int or not 0 <= value <= 100:
            raise QualityScoringError("评分必须为 0–100 整数")
    category = raw["content_category"]
    if not isinstance(category, str) or category not in WEIGHTS:
        raise QualityScoringError("未知内容类型")
    if type(raw["should_curate"]) is not bool:
        raise QualityScoringError("should_curate 必须是布尔值")
    reason = raw["reason"]
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 2000:
        raise QualityScoringError("缺少有效 AI 评价")
    dims = dict(dims)
    if duplicate:
        dims["originality"] = 0
    score = round(sum(dims[key] * weight for key, weight in zip(DIMENSIONS[:5], WEIGHTS[category], strict=True))
                  - .5 * dims["noise_penalty"])
    score = max(0, min(100, score))
    if duplicate:
        score = min(score, 49)
        reason += "；正文与已有精选完全重复，无新增知识价值"
    passed = quality_passes(score, dims, category, duplicate=duplicate)
    return {
        "quality_score": score, "dimensions": dims, "content_category": category,
        "reason": reason.strip(), "should_curate": passed,
    }


def quality_passes(
    score: int, dimensions: dict[str, int], category: str, *,
    threshold: int = QUALITY_THRESHOLD, duplicate: bool = False,
) -> bool:
    """Shared admission policy; evaluation may sweep thresholds without changing production."""
    passed = (not duplicate and score >= threshold and dimensions["information_value"] >= 50
              and dimensions["noise_penalty"] < 50)
    if category == "tactical_analysis":
        passed = passed and dimensions["analysis_depth"] >= 60 and dimensions["reference_value"] >= 60
    if category == "community_discussion":
        passed = passed and dimensions["information_value"] >= 70 and dimensions["reference_value"] >= 70
    return passed


def build_quality_input(
    title: str, author: str, text: str, *, source_url: str = "", publish_time: str = "", duplicate: bool = False,
    evaluated_at: str | None = None,
) -> str:
    if len(text) > MAX_BODY_CHARS:
        raise QualityScoringError("全文超出评分输入上限，需人工复核（不截断后放行）")
    return json.dumps({
        "title": title, "author_claim_unverified": author, "source_url": source_url,
        "publish_time": publish_time or None, "evaluated_at": evaluated_at or datetime.now(UTC).isoformat(),
        "exact_duplicate_in_vault": duplicate, "body": text,
    }, ensure_ascii=False)


async def score_article(**material: Any) -> dict[str, Any]:
    """Explicit opt-in OpenAI-compatible endpoint. Tests inject a local scorer instead."""
    if os.getenv("KPL_QUALITY_MODEL_CALLS_ENABLED") != "true":
        raise QualityScoringError("AI 评分未启用，待复核")
    base = os.getenv("KPL_QUALITY_API_BASE", "").rstrip("/")
    model = os.getenv("KPL_QUALITY_MODEL", "")
    key = os.getenv("KPL_QUALITY_API_KEY", "")
    if not base or not model or not key:
        raise QualityScoringError("AI 评分配置不完整，待复核")
    user = build_quality_input(**material)
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(f"{base}/chat/completions", headers={"Authorization": f"Bearer {key}"}, json={
                "model": model,
                "messages": [
                    {"role": "system", "content": PROMPT_PATH.read_text(encoding="utf-8")},
                    {"role": "user", "content": user},
                ],
                "response_format": {"type": "json_object"}, "temperature": 0, "max_tokens": 1600,
            })
            response.raise_for_status()
            payload = response.json()
            choice = payload["choices"][0]
            if choice.get("finish_reason") != "stop":
                raise QualityScoringError("AI 评分未完整结束")
            return json.loads(choice["message"]["content"])
    except QualityScoringError:
        raise
    except Exception:
        # Do not persist provider URLs, API keys or raw response bodies in public audit files.
        raise QualityScoringError("AI 评分请求失败或响应无法解析，待复核") from None


def quality_metadata(result: dict[str, Any], text: str) -> dict[str, Any]:
    return {
        "quality_score": result["quality_score"], "quality_dimensions": result["dimensions"],
        "content_category": result["content_category"], "ai_reason": result["reason"],
        "should_curate": result["should_curate"], "content_fingerprint": content_fingerprint(text),
        "quality_evaluation": {
            "version": SCORING_VERSION, "model": os.getenv("KPL_QUALITY_MODEL", "injected-scorer"),
            "evaluated_at": datetime.now(UTC).isoformat(),
        },
    }
