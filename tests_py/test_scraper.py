"""kpl_scraper 纯函数的单元测试（不触网、不读写真实文件系统）。"""

import pytest

from kpl_scraper import extract_publish_time, format_timestamp, process_wechat_html, sanitize_filename


class TestSanitizeFilename:
    def test_illegal_chars_replaced(self):
        assert sanitize_filename('a/b\\c:d*e?f"g<h>i|j') == "a_b_c_d_e_f_g_h_i_j"

    def test_chinese_preserved(self):
        assert sanitize_filename("王者荣耀总决赛") == "王者荣耀总决赛"

    def test_whitespace_stripped_and_collapsed(self):
        assert sanitize_filename("  hello   world  ") == "hello world"
        assert sanitize_filename("   ") == "untitled"

    def test_truncated_to_max_len(self):
        assert len(sanitize_filename("长" * 100)) == 60
        assert sanitize_filename("ab" * 10, max_len=10) == "ababababab"

    def test_empty_returns_untitled(self):
        assert sanitize_filename("") == "untitled"


class TestFormatTimestamp:
    def test_known_timestamp_beijing(self):
        # 北京时间（UTC+8），实测锚点
        assert format_timestamp(1727740800) == "2024-10-01 08:00:00"

    def test_midnight_beijing(self):
        assert format_timestamp(1727712000) == "2024-10-01 00:00:00"


class TestExtractPublishTime:
    def test_jsdecode_form(self):
        html = "var create_time : JsDecode('1727740800');"
        assert extract_publish_time(html) == "2024-10-01 08:00:00"

    def test_plain_string_form(self):
        assert extract_publish_time("create_time = '1727740800'") == "2024-10-01 08:00:00"

    def test_invalid_ts_returns_empty(self):
        assert extract_publish_time("create_time : JsDecode('abc')") == ""

    def test_empty_html_returns_empty(self):
        assert extract_publish_time("") == ""
        assert extract_publish_time("<html><body>没有时间戳</body></html>") == ""


class TestProcessWechatHtml:
    @staticmethod
    def minimal_wechat_html() -> str:
        return """
        <html><body>
        <h1 class="rich_media_title" id="activity-name">KPL 夏季赛总决赛战报</h1>
        <span class="rich_media_meta_nickname" id="js_name">KPL王者荣耀职业联赛</span>
        <div id="js_content">
            <p>第一段成都AG超玩会。</p>
            <img src="https://mmbiz.qpic.cn/cover.jpg" />
            <p>第二段重庆狼队。</p>
        </div>
        </body></html>
        """

    def test_extracts_title_author_and_strips_images(self):
        parsed = process_wechat_html(self.minimal_wechat_html())
        assert parsed["title"] == "KPL 夏季赛总决赛战报"
        assert parsed["author"] == "KPL王者荣耀职业联赛"
        assert "mmbiz.qpic.cn" not in parsed["markdown_body"]
        assert "成都AG超玩会" in parsed["markdown_body"]
        assert "重庆狼队" in parsed["markdown_body"]

    def test_missing_content_raises(self):
        with pytest.raises(ValueError):
            process_wechat_html("<html><body><p>没有正文区域</p></body></html>")
