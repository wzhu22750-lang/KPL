#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KPL 微信公众号文章高保真纯文本抓取与归档工具（无图纯净版）
- 采用 curl-cffi 模拟浏览器真实 TLS 指纹 (JA3/JA4)，秒级直通免封控
- 自动提取元数据：标题、作者/公众号、发布时间、原文链接
- 完整提取文本语义结构，保留大纲标题、引用、列表、代码块、加粗等排版
- 【无图模式】：剔除所有图片、动图、海报、占位符及配图代码，保证产物纯净精炼
- 产出产物：
    1. 纯净结构化 Markdown (.md)
    2. 离线精简 HTML (.html)
    3. 结构化元数据 (metadata.json)
"""

import os
import re
import sys
import json
import asyncio
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List

import markdownify
from bs4 import BeautifulSoup
from curl_cffi import requests as curl_requests


# ============================================================
# 基础配置
# ============================================================

DEFAULT_OUTPUT_DIR = Path("./kpl_articles")
REQUEST_TIMEOUT = 25
CHROME_IMPERSONATE = "chrome124"

FIXED_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


# ============================================================
# 工具函数
# ============================================================

def format_timestamp(ts: int) -> str:
    """Unix 时间戳转标准格式 YYYY-MM-DD HH:mm:ss (北京时间)"""
    tz = timezone(timedelta(hours=8))
    dt = datetime.fromtimestamp(ts, tz=tz)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def extract_publish_time(html: str) -> str:
    """从 script 脚本中提取文章发布时间"""
    m = re.search(r"create_time\s*:\s*JsDecode\('([^']+)'\)", html)
    if m:
        try:
            ts = int(m.group(1))
            if ts > 0:
                return format_timestamp(ts)
        except ValueError:
            pass

    m = re.search(r"create_time\s*[:=]\s*['\"](\d+)['\"]", html)
    if m:
        try:
            return format_timestamp(int(m.group(1)))
        except ValueError:
            pass

    return ""


def sanitize_filename(name: str, max_len: int = 60) -> str:
    """清洗文件名中的非法字符"""
    clean = re.sub(r'[/\\:*?"<>|]', "_", name).strip()
    clean = re.sub(r"\s+", " ", clean)
    return clean[:max_len] if clean else "untitled"


# ============================================================
# 正文清洗与格式转换（无图纯净版）
# ============================================================

def process_wechat_html(raw_html: str) -> Dict[str, Any]:
    """解析并结构化微信文章纯文本内容（彻底剥离所有图片）"""
    soup = BeautifulSoup(raw_html, "html.parser")

    # 1. 提取元数据
    title_el = soup.select_one("#activity-name")
    title = title_el.get_text(strip=True) if title_el else ""
    if not title:
        og_title = soup.select_one('meta[property="og:title"]')
        title = og_title["content"] if og_title else "未命名文章"

    author_el = soup.select_one("#js_name") or soup.select_one(".profile_nickname")
    author = author_el.get_text(strip=True) if author_el else ""

    pub_time = extract_publish_time(raw_html)

    content_el = soup.select_one("#js_content")
    if not content_el:
        raise ValueError("未能找到正文区域 (#js_content)，可能遭遇反爬验证或文章已删除")

    # 2. 彻底移除所有图片、动图、图集、svg、多媒体与广告标签
    for tag_name in ["img", "figure", "picture", "svg", "video", "audio"]:
        for el in content_el.find_all(tag_name):
            el.decompose()

    # 3. 抽取代码块
    code_blocks = []
    for el in content_el.select(".code-snippet__fix"):
        for line_idx in el.select(".code-snippet__line-index"):
            line_idx.decompose()
        pre = el.select_one("pre[data-lang]")
        lang = pre.get("data-lang", "") if pre else ""
        lines = [code.get_text() for code in el.find_all("code")]
        if not lines:
            lines = [el.get_text()]
        placeholder = f"CODEBLOCK_PLACEHOLDER_{len(code_blocks)}"
        code_blocks.append({"lang": lang, "code": "\n".join(lines)})
        el.replace_with(soup.new_tag("p", string=placeholder))

    # 4. 移除噪声元素
    for sel in (
        "script", "style", ".qr_code_pc", ".reward_area", ".share_media",
        "#js_sponsor_ad_area", ".rich_media_tool", ".rich_media_area_extra"
    ):
        for tag in content_el.select(sel):
            tag.decompose()

    # 5. HTML 转 Markdown (明确排除 img)
    content_html = str(content_el)
    md = markdownify.markdownify(
        content_html,
        heading_style="ATX",
        bullets="-",
        convert=[
            "p", "h1", "h2", "h3", "h4", "h5", "h6",
            "strong", "em", "a", "ul", "ol", "li",
            "blockquote", "br", "hr", "table", "thead",
            "tbody", "tr", "th", "td", "pre", "code"
        ],
    )

    # 还原代码块
    for i, block in enumerate(code_blocks):
        placeholder = f"CODEBLOCK_PLACEHOLDER_{i}"
        fenced = f"\n```{block['lang']}\n{block['code']}\n```\n"
        md = md.replace(placeholder, fenced)

    # 彻底清理任何残存的图片 Markdown 语法 ![...] (...)
    md = re.sub(r"!\[.*?\]\(.*?\)", "", md)
    md = md.replace("\u00a0", " ")
    md = re.sub(r"\n{3,}", "\n\n", md)
    md = re.sub(r"[ \t]+$", "", md, flags=re.MULTILINE)

    return {
        "title": title,
        "author": author,
        "publish_time": pub_time,
        "raw_content_html": content_html,
        "markdown_body": md.strip(),
    }


# ============================================================
# 核心抓取入口
# ============================================================

async def scrape_article(
    url: str,
    output_base: Path = DEFAULT_OUTPUT_DIR,
    max_retries: int = 3
) -> Dict[str, Any]:
    """抓取单篇微信公众号文章并纯文本归档"""
    print(f"\n🚀 正在拉取文章 (无图纯净版): {url}")
    
    last_err = ""
    resp = None
    for attempt in range(1, max_retries + 1):
        try:
            resp = curl_requests.get(
                url,
                headers=FIXED_HEADERS,
                impersonate=CHROME_IMPERSONATE,
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code == 200 and "环境异常" not in resp.text and "#js_content" in resp.text:
                break
            elif "环境异常" in resp.text:
                last_err = "触发腾讯反爬拦截 (环境异常)"
            elif resp.status_code != 200:
                last_err = f"HTTP {resp.status_code}"
            else:
                last_err = "页面未渲染出正文，可能遭遇限流"
        except Exception as e:
            last_err = str(e)
        
        if attempt < max_retries:
            wait_time = attempt * 2
            print(f"  ⚠ 第 {attempt} 次请求未获完整页面 ({last_err})，{wait_time} 秒后重试...")
            await asyncio.sleep(wait_time)

    if not resp or resp.status_code != 200 or "#js_content" not in resp.text:
        print(f"❌ 抓取失败: {last_err}")
        return {"status": "error", "error": last_err, "url": url}

    # 解析正文
    try:
        parsed = process_wechat_html(resp.text)
    except Exception as e:
        print(f"❌ 解析失败: {e}")
        return {"status": "error", "error": str(e), "url": url}

    title = parsed["title"]
    author = parsed["author"]
    pub_time = parsed["publish_time"]
    final_md_body = parsed["markdown_body"]

    print(f"📄 标题: {title}")
    print(f"👤 公众号: {author}")
    print(f"📅 发布时间: {pub_time}")
    print(f"📝 纯文本正文字数: {len(final_md_body)} 字")

    # 准备落地目录（纯净模式，无 images 目录）
    folder_name = f"{pub_time[:10]}_{sanitize_filename(title)}" if pub_time else sanitize_filename(title)
    article_dir = output_base / folder_name
    article_dir.mkdir(parents=True, exist_ok=True)

    # 1. 写入 Markdown
    header_lines = [
        f"# {title}",
        "",
        f"> **公众号**: {author}  ",
        f"> **发布时间**: {pub_time}  ",
        f"> **原文链接**: [{url}]({url})  ",
        "",
        "---",
        "",
    ]
    full_markdown = "\n".join(header_lines) + final_md_body
    md_file = article_dir / f"{sanitize_filename(title)}.md"
    md_file.write_text(full_markdown, encoding="utf-8")

    # 2. 写入轻量离线 HTML（无图，排版清晰）
    html_template = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
        body {{ max-width: 760px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.8; color: #222; }}
        h1 {{ font-size: 24px; line-height: 1.4; }}
        .meta {{ color: #777; font-size: 14px; margin-bottom: 24px; border-bottom: 1px solid #eee; padding-bottom: 12px; }}
        blockquote {{ border-left: 4px solid #ddd; margin: 1.5em 0; padding-left: 16px; color: #555; }}
        p {{ margin: 1em 0; }}
    </style>
</head>
<body>
    <h1>{title}</h1>
    <div class="meta">公众号: {author} | 时间: {pub_time} | <a href="{url}" target="_blank">查看原文</a></div>
    <div class="content">{parsed["raw_content_html"]}</div>
</body>
</html>"""
    (article_dir / "offline.html").write_text(html_template, encoding="utf-8")

    # 3. 导出结构化元数据 JSON
    meta_info = {
        "title": title,
        "author": author,
        "publish_time": pub_time,
        "source_url": url,
        "has_images": False,
        "markdown_file": str(md_file.name),
        "word_count": len(final_md_body),
        "archived_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    (article_dir / "metadata.json").write_text(json.dumps(meta_info, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"🎉 归档成功! 存放于: {article_dir}")
    return {"status": "ok", "title": title, "path": str(article_dir), "meta": meta_info}


async def batch_scrape(urls: List[str], output_dir: Path = DEFAULT_OUTPUT_DIR):
    """批量抓取多篇文章（无图版）"""
    output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    print(f"📋 开始批量抓取（无图纯净版），共 {len(urls)} 篇文章...")
    for idx, url in enumerate(urls, 1):
        print(f"\n[{idx}/{len(urls)}] ----------------------------------------")
        res = await scrape_article(url, output_dir)
        results.append(res)
        if idx < len(urls):
            import random
            delay = round(random.uniform(1.0, 2.0), 2)
            await asyncio.sleep(delay)

    print("\n================== 抓取结果汇总 ==================")
    success_count = sum(1 for r in results if r.get("status") == "ok")
    print(f"总计: {len(urls)} 篇 | 成功: {success_count} 篇 | 失败: {len(urls) - success_count} 篇")


def main():
    if len(sys.argv) < 2:
        print("用法:")
        print("  python3 kpl_scraper.py <微信文章URL1> [微信文章URL2] ...")
        print("  python3 kpl_scraper.py --file urls.txt")
        sys.exit(1)

    urls = []
    if sys.argv[1] == "--file":
        if len(sys.argv) < 3:
            print("❌ 请指定包含 URL 的文件路径")
            sys.exit(1)
        filepath = Path(sys.argv[2])
        if not filepath.exists():
            print(f"❌ 文件不存在: {filepath}")
            sys.exit(1)
        urls = [line.strip() for line in filepath.read_text(encoding="utf-8").splitlines() if line.strip().startswith("http")]
    else:
        urls = [u for u in sys.argv[1:] if u.startswith("http")]

    if not urls:
        print("❌ 未提供有效的文章 URL")
        sys.exit(1)

    asyncio.run(batch_scrape(urls))


if __name__ == "__main__":
    main()
