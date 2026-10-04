"""dajiala_client 的单元测试（不触网：只测配置解析与纯文本清洗函数）。"""

import pytest

from dajiala_client import DajialaClient, sanitize_title


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
        (isolated / ".env").write_text(
            "# 注释\nOTHER_VAR=1\nDAJIALA_API_KEY=abc\n", encoding="utf-8"
        )
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
