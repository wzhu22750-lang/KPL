"""curator.evaluate_article_quality 的单元测试（不触网）。

断言全部以 OPTIMIZATION_PROMPT.md 阶段 2.2 要求的"先实测后断言"流程为准：
字数门槛是 `len(clean_text) < 800`（恰好 800 字能过字数门，但会被相关度规则拦）。
"""

from curator import evaluate_article_quality, extract_candidate_urls

NEUTRAL_FILLER = "这段文字只是普通的内容填充，用于凑足篇幅门槛。"
STRONG_CORE = "KPL 王者荣耀职业联赛。成都AG超玩会对阵重庆狼队。一诺与Fly再次交手。"


def repeat_to_length(core: str, target: int) -> str:
    """把 core 重复拼接后截断/补足到 target 长度（core 不含黑名单词时截断无副作用）。"""
    reps = max(1, target // len(core) + 1)
    return (core * reps)[:target]


class TestExcludeKeywords:
    def test_title_hit_cfs(self):
        ok, reason, _, tag = evaluate_article_quality(
            "CFS世界总决赛今日开幕", "某公众号", repeat_to_length(NEUTRAL_FILLER, 900)
        )
        assert ok is False
        assert "CFS" in reason
        assert tag == "其他赛事"

    def test_title_hit_lpl(self):
        ok, reason, _, tag = evaluate_article_quality(
            "LPL春季赛焦点战回顾", "某公众号", repeat_to_length(NEUTRAL_FILLER, 900)
        )
        assert ok is False
        assert "LPL" in reason
        assert tag == "其他赛事"

    def test_title_hit_valorant(self):
        ok, reason, _, _ = evaluate_article_quality(
            "无畏契约全球冠军赛观赛指南", "某公众号", repeat_to_length(NEUTRAL_FILLER, 900)
        )
        assert ok is False
        assert "无畏契约" in reason

    def test_body_dominant_other_game(self):
        # 标题不含 KPL/王者荣耀，正文"英雄联盟"出现 5 次（>=4）→ 按正文主导判负
        body = repeat_to_length("英雄联盟" + NEUTRAL_FILLER, 900)
        ok, reason, _, tag = evaluate_article_quality("春季赛决赛回顾", "某公众号", body)
        assert ok is False
        assert "英雄联盟" in reason
        assert tag == "其他赛事"


class TestWordCountGate:
    def test_799_chars_rejected(self):
        ok, reason, _, tag = evaluate_article_quality("普通文章标题", "作者", "这" * 799)
        assert ok is False
        assert "篇幅不足" in reason
        assert "799" in reason
        assert tag == "短讯"

    def test_800_chars_boundary(self):
        # 实测：门槛是 < 800，恰好 800 字能过字数门；随后被 KPL 相关度规则拦（非字数原因）
        ok, reason, _, _ = evaluate_article_quality("普通文章标题", "作者", "字" * 800)
        assert ok is False
        assert "篇幅" not in reason
        assert "KPL 核心实体" in reason

    def test_801_chars_passes_gate(self):
        body = repeat_to_length(STRONG_CORE, 801)
        ok, reason, _, _ = evaluate_article_quality("KPL夏季赛总决赛战报", "KPL联盟", body)
        assert ok is True
        assert "审核通过" in reason


class TestCoreEntities:
    def test_zero_kpl_entity_rejected(self):
        ok, reason, _, tag = evaluate_article_quality("普通文章标题", "作者", "字" * 800)
        assert ok is False
        assert "KPL 核心实体关联度极弱" in reason
        assert tag == "泛电竞"

    def test_strong_kpl_article_passes(self):
        # 与实测探针完全一致的输入：标题含 KPL + 核心战队/选手多次命中 + 超 800 字
        ok, reason, category, tag = evaluate_article_quality("KPL夏季赛总决赛战报", "KPL联盟", STRONG_CORE * 30)
        assert ok is True
        assert "审核通过" in reason
        assert category == "成都AG超玩会"
        assert tag == "官方决战与赛程"


class TestExtractCandidateUrls:
    def test_mixed_string_and_dict_items(self):
        data = {
            "KPL官方": [{"url": "https://mp.weixin.qq.com/s/a", "title": "T"}],
            "手动补充": ["https://mp.weixin.qq.com/s/b"],
            "脏数据": [{"url": ""}, "   ", 123, None, {"title": "没有url"}],
        }
        assert extract_candidate_urls(data) == [
            "https://mp.weixin.qq.com/s/a",
            "https://mp.weixin.qq.com/s/b",
        ]

    def test_non_list_values_ignored(self):
        assert extract_candidate_urls({"meta": "not-a-list", "count": 3}) == []
