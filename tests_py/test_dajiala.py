"""dajiala_client 的单元测试（不触网：只测配置解析、纯文本清洗与导出逻辑）。"""

import json
from pathlib import Path

import pytest

from curator import extract_candidate_urls
from dajiala_client import (
    DajialaClient,
    collect_wechat_metas,
    export_discovered_json,
    parse_export_args,
    run_export,
    sanitize_title,
)


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """隔离环境：删除环境变量、工作目录切到 tmp_path（保证读不到真实 .env）。"""
    monkeypatch.delenv("DAJIALA_API_KEY", raising=False)
    monkeypatch.chdir(tmp_path)
    return tmp_path


class TestConfig:
    def test_not_configured_without_key_or_env_file(self, isolated):
        assert DajialaClient().is_configured() is False

    def test_missing_key_gives_chinese_error(self, isolated):
        client = DajialaClient()
        with pytest.raises(ValueError, match="DAJIALA_API_KEY"):
            client.get_weibo_timeline(uid="12345")
        with pytest.raises(ValueError, match="DAJIALA_API_KEY"):
            client.get_wechat_history(biz="gh_xxx")

    def test_reads_plain_env_value(self, isolated):
        (isolated / ".env").write_text("DAJIALA_API_KEY=abc\n", encoding="utf-8")
        client = DajialaClient()
        assert client.is_configured() is True
        assert client.api_key == "abc"

    def test_reads_double_quoted_env_value(self, isolated):
        (isolated / ".env").write_text('DAJIALA_API_KEY="abc"\n', encoding="utf-8")
        assert DajialaClient().api_key == "abc"

    def test_reads_single_quoted_env_value(self, isolated):
        (isolated / ".env").write_text("DAJIALA_API_KEY='abc'\n", encoding="utf-8")
        assert DajialaClient().api_key == "abc"

    def test_surrounding_lines_are_ignored(self, isolated):
        (isolated / ".env").write_text("# 注释\nOTHER_VAR=1\nDAJIALA_API_KEY=abc\n", encoding="utf-8")
        assert DajialaClient().api_key == "abc"

    def test_env_var_takes_priority_over_env_file(self, isolated, monkeypatch):
        monkeypatch.setenv("DAJIALA_API_KEY", "from-env")
        (isolated / ".env").write_text("DAJIALA_API_KEY=from-file\n", encoding="utf-8")
        assert DajialaClient().api_key == "from-env"


class TestSanitizeTitle:
    def test_strips_hashtags_and_newlines(self):
        assert sanitize_title("#王者荣耀# 2025夏季赛/总决赛:战报", 40) == "王者荣耀 2025夏季赛_总决赛_战报"

    def test_truncated_to_max_len(self):
        assert len(sanitize_title("x" * 50)) == 40
        assert sanitize_title("x" * 50, max_len=10) == "x" * 10

    def test_empty_returns_default(self):
        assert sanitize_title("") == "微博动态"


class TestCleanWeiboText:
    def test_strips_media_tags_and_emotion_codes(self):
        raw = '<a href="x">看</a><img src="y.jpg"/>[doge] 成都AG超玩会 赢下 <span>重庆狼队</span>'
        out = DajialaClient.clean_weibo_text(raw)
        assert "<img" not in out
        assert "doge" not in out
        assert "成都AG超玩会" in out
        assert "重庆狼队" in out

    def test_empty_input_returns_empty(self):
        assert DajialaClient.clean_weibo_text("") == ""


POST_HISTORY_RESPONSE = {
    "data": {
        "list": [
            {"title": "KPL 夏季赛总决赛战报", "url": "https://mp.weixin.qq.com/s/abc", "post_time": 1727740800},
            {"title": "第二篇", "link": "https://mp.weixin.qq.com/s/def", "create_time": "1727740800"},
            {"title": "无链接的条目会被跳过"},
            {"title": "重复条目", "url": "https://mp.weixin.qq.com/s/abc"},
        ]
    }
}


class TestCollectWechatMetas:
    def test_maps_appmsg_style_fields(self):
        metas = collect_wechat_metas(POST_HISTORY_RESPONSE, default_author="KPL官方")
        assert metas == [
            {
                "url": "https://mp.weixin.qq.com/s/abc",
                "title": "KPL 夏季赛总决赛战报",
                "author": "KPL官方",
                "publish_time": "2024-10-01 08:00:00",
            },
            {
                "url": "https://mp.weixin.qq.com/s/def",
                "title": "第二篇",
                "author": "KPL官方",
                "publish_time": "2024-10-01 08:00:00",
            },
        ]

    def test_skips_missing_url_and_dedupes_by_url(self):
        metas = collect_wechat_metas(POST_HISTORY_RESPONSE, default_author="KPL官方")
        assert [m["url"] for m in metas] == [
            "https://mp.weixin.qq.com/s/abc",
            "https://mp.weixin.qq.com/s/def",
        ]

    def test_non_numeric_publish_time_passthrough(self):
        resp = {"list": [{"title": "T", "url": "https://mp.weixin.qq.com/s/x", "post_time": "2025-01-01 10:00:00"}]}
        assert collect_wechat_metas(resp)[0]["publish_time"] == "2025-01-01 10:00:00"


class TestExportFlow:
    def test_parse_export_args_defaults(self):
        out, biz, pages = parse_export_args(["--export-json"])
        assert out == Path("discovered_urls.json")
        assert biz == []
        assert pages == 1

    def test_parse_export_args_full(self):
        out, biz, pages = parse_export_args(["--export-json", "out.json", "--biz", "gh_a, gh_b", "--pages", "2"])
        assert out == Path("out.json")
        assert biz == ["gh_a", "gh_b"]
        assert pages == 2

    def test_run_export_without_key_prints_guidance(self, isolated, capsys):
        run_export([])
        assert "无法拉取公众号文章列表" in capsys.readouterr().out

    def test_run_export_end_to_end_with_fake_client(self, isolated, monkeypatch):
        """mock 掉网络层后走完整导出流程：产物可被 json.load，且 curator 能取回 URL。"""
        out = isolated / "discovered_urls.json"

        class FakeClient:
            # run_export 只用到 is_configured 与 get_wechat_history
            def is_configured(self):
                return True

            def get_wechat_history(self, biz, page):
                return POST_HISTORY_RESPONSE

        monkeypatch.setattr("dajiala_client.DajialaClient", FakeClient)
        run_export(["--export-json", str(out)])

        data = json.loads(out.read_text(encoding="utf-8"))
        assert "KPL王者荣耀职业联赛" in data
        articles = data["KPL王者荣耀职业联赛"]
        assert len(articles) == 2
        assert all({"url", "title", "author", "publish_time"} <= set(a) for a in articles)
        assert [a["author"] for a in articles] == ["KPL王者荣耀职业联赛", "KPL王者荣耀职业联赛"]
        # curator.py 侧能从该结构取回候选 URL（打通链路的最终判据）
        assert extract_candidate_urls(data) == [
            "https://mp.weixin.qq.com/s/abc",
            "https://mp.weixin.qq.com/s/def",
        ]

    def test_export_discovered_json_skips_empty_accounts(self, isolated):
        out = isolated / "out.json"
        export_discovered_json({"A号": [{"url": "https://mp.weixin.qq.com/s/a"}], "B号": []}, out)
        data = json.loads(out.read_text(encoding="utf-8"))
        assert list(data.keys()) == ["A号"]
