"""Offline policy/contract tests. Fixed model outputs do NOT measure LLM semantic accuracy."""

import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import curator
from curator import assess_article, evaluate_article_quality, evaluate_article_rules, extract_candidate_urls
from quality_scoring import DIMENSIONS, content_fingerprint, normalize_quality_result

BP_TEXT = (
    "KPL季后赛第三局BP复盘：蓝方先选大乔，红方用东皇限制电梯撤退。"
    "第8分钟蓝方提前把兵线送进中塔，迫使红方交出传送支援，随后转暴君形成多打少。"
    "录像显示两次转线都先推边线，因此关键并非英雄胜率，而是线权先后；"
    "若红方保留边路清线技能并延后接团，这套强开会失去人数优势。"
)
FAN_TEXT = "一诺太强了！成都AG超玩会未来一定夺冠！永远支持，封神！" * 40
OFFICIAL_TEXT = "KPL联盟公告：2026年春季赛季后赛4月10日起采用BO7，前四局全局BP不重复使用英雄。详见本公告竞赛规程第3条。"
CLICKBAIT_TEXT = "KPL震惊！选手封神的秘密曝光！" + "点关注，私信领惊喜，一切尽在不言中。" * 50


def output(category="tactical_analysis", dims=(92, 90, 80, 70, 94, 5), reason="提供具体BP时序、线权与资源因果证据"):
    return {"quality_score": 99, "dimensions": dict(zip(DIMENSIONS, dims, strict=True)),
            "content_category": category, "reason": reason, "should_curate": True}


def assess(title, body, raw, **kwargs):
    scorer = AsyncMock(return_value=raw)
    return asyncio.run(assess_article(title, "待核验作者", body, scorer=scorer, **kwargs)), scorer


class TestRuleLayer:
    @pytest.mark.parametrize("keyword", ["CFS", "LPL", "无畏契约"])
    def test_other_game_title_still_blocked(self, keyword):
        ok, reason, _, tag = evaluate_article_rules(f"{keyword}决赛", "作者", "职业赛事内容" * 200)
        assert not ok and keyword in reason and tag == "其他赛事"

    def test_other_game_body_still_blocked(self):
        ok, reason, _, _ = evaluate_article_rules("职业赛事回顾", "作者", "英雄联盟春季赛事" * 5)
        assert not ok and "英雄联盟" in reason

    def test_one_entity_sufficient_for_ai_review(self):
        assert evaluate_article_rules("第三局BP分析", "作者", BP_TEXT)[0]
        assert len(BP_TEXT) < 800

    @pytest.mark.parametrize("body", ["", "  ", "字" * 900])
    def test_empty_or_garbage(self, body):
        assert not evaluate_article_rules("KPL战报", "作者", body)[0]

    def test_ad_blocked_before_llm(self):
        result, scorer = assess("KPL优惠券领取", BP_TEXT, output())
        assert result["status"] == "rejected"
        scorer.assert_not_awaited()

    def test_unrelated_blocked_before_llm(self):
        result, scorer = assess("普通文章", "今天讨论烹饪及旅行相关信息。", output())
        assert result["status"] == "rejected"
        scorer.assert_not_awaited()

    def test_legacy_tuple_never_admits_without_quality(self):
        ok, reason, _, _ = evaluate_article_quality("KPL战报", "作者", BP_TEXT)
        assert not ok and "待复核" in reason


class TestEditorialCases:
    def test_case1_short_bp_high_score(self):
        result, _ = assess("KPL季后赛BP复盘", BP_TEXT, output())
        assert result["status"] == "passed"
        assert result["quality"]["quality_score"] >= 85
        assert result["quality"]["content_category"] == "tactical_analysis"

    def test_case2_long_fan_praise_low_score(self):
        assert len(FAN_TEXT) > 800
        result, _ = assess("一诺封神成都AG", FAN_TEXT,
                           output("community_discussion", (10, 5, 10, 60, 5, 95), "只有应援与夺冠预测，无比赛事实"))
        assert result["status"] == "rejected"
        assert result["quality"]["quality_score"] < 30

    def test_case3_short_official_announcement(self):
        result, _ = assess("KPL季后赛竞赛规程公告", OFFICIAL_TEXT,
                           output("official_news", (95, 10, 60, 95, 85, 0), "公告说明执行日期、BO7及BP限制"))
        assert result["status"] == "passed"
        assert result["quality"]["quality_score"] >= 80

    def test_case4_clickbait(self):
        result, _ = assess("KPL选手封神秘密曝光", CLICKBAIT_TEXT,
                           output("player_story", (5, 0, 5, 50, 0, 95), "标题承诺未兑现，正文只诱导关注"))
        assert result["status"] == "rejected"
        assert result["quality"]["quality_score"] < 30

    def test_case5_identical_repost_lowered_and_rejected(self):
        original, _ = assess("KPL BP复盘", BP_TEXT, output())
        repost, scorer = assess("KPL BP转载", BP_TEXT, output(), duplicate=True)
        assert repost["quality"]["quality_score"] < original["quality"]["quality_score"]
        assert repost["quality"]["quality_score"] <= 49
        assert repost["quality"]["dimensions"]["originality"] == 0
        assert repost["status"] == "rejected"
        assert scorer.call_args.kwargs["duplicate"] is True

    def test_nonidentical_repost_reduces_originality_score(self):
        original = normalize_quality_result(output())
        repost = normalize_quality_result(output(dims=(92, 90, 5, 70, 94, 5)))
        assert repost["quality_score"] < original["quality_score"]

    def test_community_needs_reference_and_information_not_popularity(self):
        result = normalize_quality_result(output("community_discussion", (69, 100, 100, 100, 100, 0)))
        assert result["quality_score"] > 70 and not result["should_curate"]

    def test_tactics_need_causal_depth(self):
        result = normalize_quality_result(output(dims=(100, 59, 100, 100, 100, 0)))
        assert result["quality_score"] > 70 and not result["should_curate"]

    def test_old_tactics_can_pass_with_reference_value(self):
        result = normalize_quality_result(output(dims=(92, 90, 80, 0, 94, 5)))
        assert result["should_curate"]

    def test_noise_veto_even_with_high_positive_scores(self):
        result = normalize_quality_result(output(dims=(100, 100, 100, 100, 100, 50)))
        assert result["quality_score"] == 75 and not result["should_curate"]

    def test_threshold_boundary(self):
        assert normalize_quality_result(output(dims=(70, 70, 70, 70, 70, 0)))["should_curate"]
        assert not normalize_quality_result(output(dims=(69, 69, 69, 69, 69, 0)))["should_curate"]

    def test_model_total_and_boolean_are_not_authority(self):
        raw = output()
        raw.update(quality_score=0, should_curate=False)
        normalized = normalize_quality_result(raw)
        assert normalized["quality_score"] > 80 and normalized["should_curate"]


class TestFailureClosed:
    @pytest.mark.parametrize("mutation", [
        lambda raw: raw.pop("reason"),
        lambda raw: raw["dimensions"].pop("originality"),
        lambda raw: raw["dimensions"].update(information_value=True),
        lambda raw: raw["dimensions"].update(analysis_depth=101),
        lambda raw: raw["dimensions"].update(analysis_depth="90"),
        lambda raw: raw.update(content_category="roster_move"),
        lambda raw: raw.update(content_category=[]),
        lambda raw: raw.update(should_curate="true"),
        lambda raw: raw.update(reason=""),
        lambda raw: raw.update(quality_score=-1),
        lambda raw: raw.update(extra="unsafe"),
    ])
    def test_invalid_output_pending(self, mutation):
        raw = output()
        mutation(raw)
        result, _ = assess("KPL BP复盘", BP_TEXT, raw)
        assert result["status"] == "pending_review" and result["quality"] is None

    def test_unavailable_model_pending(self):
        scorer = AsyncMock(side_effect=TimeoutError("secret-key-must-not-leak"))
        result = asyncio.run(assess_article("KPL BP", "作者", BP_TEXT, scorer=scorer))
        assert result["status"] == "pending_review"
        assert "secret" not in result["reason"]

    def test_disabled_by_default(self, monkeypatch):
        monkeypatch.delenv("KPL_QUALITY_MODEL_CALLS_ENABLED", raising=False)
        result = asyncio.run(assess_article("KPL BP", "作者", BP_TEXT))
        assert result["status"] == "pending_review"

    def test_long_input_not_silently_truncated(self):
        result, scorer = assess("KPL BP", BP_TEXT * 1000, output())
        assert result["status"] == "pending_review"
        scorer.assert_not_awaited()

    def test_source_date_and_full_body_reach_scorer(self):
        _, scorer = assess("KPL BP", BP_TEXT, output(), publish_time="2026-04-01 10:00:00", source_url="https://example.test/a")
        assert scorer.call_args.kwargs["text"] == BP_TEXT
        assert scorer.call_args.kwargs["publish_time"] == "2026-04-01 10:00:00"
        assert scorer.call_args.kwargs["source_url"] == "https://example.test/a"


def test_fingerprint_normalizes_whitespace():
    assert content_fingerprint(BP_TEXT) == content_fingerprint("\n" + BP_TEXT.replace("，", "， \n"))


def test_metadata_preserves_legacy_keys(tmp_path):
    meta = {"title": "KPL BP", "source_url": "https://example.test/a", "markdown_file": "body.md"}
    res = {"path": str(tmp_path), "meta": copy.deepcopy(meta)}
    curator.save_quality_metadata(res, normalize_quality_result(output()), BP_TEXT, "联盟", "复盘")
    stored = json.loads((tmp_path / "metadata.json").read_text())
    assert all(stored[key] == value for key, value in meta.items())
    assert stored["quality_score"] > 80 and stored["ai_reason"]
    assert set(stored["quality_dimensions"]) == set(DIMENSIONS)
    assert stored["content_category"] == "tactical_analysis"
    assert stored["quality_evaluation"]["version"] == "kpl-quality-v1"


def setup_run(monkeypatch, tmp_path, body=BP_TEXT, urls=None):
    vault = tmp_path / "vault"
    source = tmp_path / "candidates.json"
    source.write_text(json.dumps({"KPL": urls or ["https://example.test/a"]}))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(curator, "VAULT_DIR", vault)
    monkeypatch.setattr(curator, "SOURCE_JSON", source)
    html = f'<h1 id="activity-name">KPL BP复盘</h1><span id="js_name">作者</span><div id="js_content">{body}</div>'
    monkeypatch.setattr(curator.requests, "get", lambda *args, **kwargs: SimpleNamespace(status_code=200, text=html))

    async def scrape(url, output_base):
        path = output_base / "2026-04-01_KPL BP复盘"
        path.mkdir(parents=True)
        meta = {"title": "KPL BP复盘", "source_url": url, "author": "作者", "markdown_file": "body.md",
                "publish_time": "2026-04-01 10:00:00", "word_count": len(body)}
        (path / "metadata.json").write_text(json.dumps(meta))
        (path / "body.md").write_text(body)
        (path / "offline.html").write_text(f'<div class="content">{body}</div>')
        return {"status": "ok", "path": str(path), "meta": meta}

    monkeypatch.setattr(curator, "scrape_article", scrape)
    return vault


def test_run_keeps_existing_vault_and_indexes_new_metadata(monkeypatch, tmp_path):
    vault = setup_run(monkeypatch, tmp_path)
    old = vault / "历史战队" / "old"
    old.mkdir(parents=True)
    meta = {"title": "旧文章", "source_url": "https://example.test/old", "markdown_file": "old.md"}
    (old / "metadata.json").write_text(json.dumps(meta))
    (old / "old.md").write_text("历史正文")
    asyncio.run(curator.run_quality_curation(scorer=AsyncMock(return_value=output())))
    assert (old / "old.md").read_text() == "历史正文"
    audit = json.loads((vault / "QUALITY_AUDIT.json").read_text())
    assert len(audit["passed"]) == 1
    assert audit["passed"][0]["meta"]["quality_score"] > 80
    index = (vault / "INDEX.md").read_text()
    assert "旧文章" in index and "tactical_analysis" in index and "未评分" in index


def test_run_duplicate_content_different_urls_only_one_admitted(monkeypatch, tmp_path):
    vault = setup_run(monkeypatch, tmp_path, urls=["https://example.test/a", "https://example.test/b"])
    asyncio.run(curator.run_quality_curation(scorer=AsyncMock(return_value=output())))
    audit = json.loads((vault / "QUALITY_AUDIT.json").read_text())
    assert len(audit["passed"]) == 1
    assert audit["rejected_or_pending"][0]["quality"]["quality_score"] <= 49
    assert len(list(vault.rglob("metadata.json"))) == 1


@pytest.mark.parametrize("failure", ["download", "changed", "changed_title", "missing_body", "http"])
def test_failed_archival_or_page_never_enters_vault(monkeypatch, tmp_path, failure):
    vault = setup_run(monkeypatch, tmp_path)
    if failure == "download":
        monkeypatch.setattr(curator, "scrape_article", AsyncMock(return_value={"status": "error"}))
    elif failure in {"changed", "changed_title"}:
        original = curator.scrape_article

        async def changed(*args, **kwargs):
            res = await original(*args, **kwargs)
            if failure == "changed":
                (Path(res["path"]) / "offline.html").write_text('<div class="content">其他正文</div>')
            else:
                res["meta"]["title"] = "KPL标题被替换"
            return res

        monkeypatch.setattr(curator, "scrape_article", changed)
    else:
        monkeypatch.setattr(curator.requests, "get", lambda *args, **kwargs: SimpleNamespace(
            status_code=500 if failure == "http" else 200, text="<html>验证页面</html>"))
    scorer = AsyncMock(return_value=output())
    asyncio.run(curator.run_quality_curation(scorer=scorer))
    assert not list(vault.rglob("metadata.json"))
    audit = json.loads((vault / "QUALITY_AUDIT.json").read_text())
    assert not audit["passed"] and audit["rejected_or_pending"]
    if failure in {"missing_body", "http"}:
        scorer.assert_not_awaited()


class TestExtractCandidateUrls:
    def test_mixed_string_and_dict_items(self):
        data = {"KPL官方": [{"url": "https://example.test/a", "title": "T"}],
                "补充": ["https://example.test/b"], "脏数据": [{"url": ""}, "   ", 123, None, {"title": "无url"}]}
        assert extract_candidate_urls(data) == ["https://example.test/a", "https://example.test/b"]

    def test_non_list_values_ignored(self):
        assert extract_candidate_urls({"meta": "not-a-list", "count": 3}) == []
