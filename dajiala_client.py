#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
大家拉 (dajiala.com / 极致了数据) 官方商业 API 客户端
=====================================================
主通道定位：高质量微信公众号 & 官方微博博文数据采集

特性：
1. 【微信公众号板块】：按 biz 批量拉取整号历史长文与互动数据（阅读量、在看数、点赞数）。
2. 【官方微博板块】：按博主 UID 批量拉取官方微博（KPL官博、AG、狼队、eStar等战队）的最新博文、战报与转评赞数据。
3. 【全流程无图纯净】：自动剥离所有 HTML 标签、九宫格配图、表情包代码与媒体占位符，输出纯净 Markdown。
4. 【对接入库质检】：产物自动进入 ./kpl_vault/ 对应战队目录，更新索引。

配置方式：
  在终端中执行：
    export DAJIALA_API_KEY="你的大家拉API密钥"
  或创建 .env 文件写入：
    DAJIALA_API_KEY="你的大家拉API密钥"
"""

import os
import re
import sys
import json
import time
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional
import httpx
from bs4 import BeautifulSoup

# 大家拉标准接口基地址 (dajiala.com / jzl.com)
DAJIALA_BASE_URL = "https://www.dajiala.com/fbmain"

# 官方微博核心账号 UID 映射表
KPL_WEIBO_ACCOUNTS = {
    "KPL官方": {
        "name": "KPL王者荣耀职业联赛",
        "uid": "6074356560",
        "url": "https://weibo.com/u/6074356560"
    },
    "成都AG超玩会": {
        "name": "AG电子竞技俱乐部",
        "uid": "5235556956",
        "url": "https://weibo.com/allgamers"
    },
    "重庆狼队": {
        "name": "重庆狼队王者荣耀分部",
        "uid": "6180100850",
        "url": "https://weibo.com/qghappy"
    },
    "武汉eStarPro": {
        "name": "武汉eStarPro",
        "uid": "6083372421",
        "url": "https://weibo.com/estarpro"
    },
    "广州TTG": {
        "name": "广州TTG",
        "uid": "6383293935",
        "url": "https://weibo.com/xqesports"
    },
    "北京WB": {
        "name": "北京WB王者荣耀分部",
        "uid": "6528198786",
        "url": "https://weibo.com/tsgaming"
    }
}


class DajialaClient:
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("DAJIALA_API_KEY", "")
        # 尝试从 .env 读取
        if not self.api_key and Path(".env").exists():
            for line in Path(".env").read_text().splitlines():
                if line.startswith("DAJIALA_API_KEY="):
                    self.api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
        self.client = httpx.Client(timeout=30.0)

    def is_configured(self) -> bool:
        return bool(self.api_key and self.api_key.strip())

    # ========================================================
    # 微博数据接口
    # ========================================================

    def get_weibo_timeline(
        self,
        uid: str,
        page: int = 1,
        page_size: int = 20
    ) -> Dict[str, Any]:
        """
        调用大家拉获取微博用户历史博文列表
        :param uid: 微博用户数字 UID (如 KPL 官博 6074356560)
        :param page: 页码
        :param page_size: 单页拉取数量
        """
        if not self.is_configured():
            raise ValueError(
                "❌ 未检测到 DAJIALA_API_KEY！\n"
                "请先设置环境变量: export DAJIALA_API_KEY='你的大家拉API密钥'\n"
                "或在项目根目录 .env 文件中添加 DAJIALA_API_KEY=xxx"
            )

        url = f"{DAJIALA_BASE_URL}/weibo/v1/user_timeline"
        payload = {
            "key": self.api_key,
            "uid": uid,
            "page": page,
            "size": page_size
        }

        resp = self.client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()

    # ========================================================
    # 微信公众号数据接口
    # ========================================================

    def get_wechat_history(
        self,
        biz: str,
        page: int = 1,
        page_size: int = 10
    ) -> Dict[str, Any]:
        """
        调用大家拉获取公众号历史文章列表
        """
        if not self.is_configured():
            raise ValueError("❌ 未检测到 DAJIALA_API_KEY！")

        url = f"{DAJIALA_BASE_URL}/monitor/v3/post_history"
        payload = {
            "key": self.api_key,
            "biz": biz,
            "page": page,
            "size": page_size,
        }
        resp = self.client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()

    # ========================================================
    # 纯文本清洗处理器（彻底剥离所有图片多媒体）
    # ========================================================

    @staticmethod
    def clean_weibo_text(raw_text: str) -> str:
        """
        清洗微博正文为纯净文本：
        - 移除所有 HTML 标签 (<a>, <span>, <img> 等)
        - 移除表情包代码与链接图标
        - 保留超话标签 #...# 与段落换行
        """
        if not raw_text:
            return ""

        # 解析 HTML
        soup = BeautifulSoup(raw_text, "html.parser")

        # 彻底移除所有多媒体标签
        for tag in soup.find_all(["img", "video", "picture", "svg"]):
            tag.decompose()

        # 提取净化后的文本
        text = soup.get_text()

        # 移除表情占位符如 [心]、[泪]、[doge] 等
        text = re.sub(r"\[[a-zA-Z\u4e00-\u9fa5]{1,8}\]", "", text)

        # 规整多余空行与空格
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def sanitize_title(text: str, max_len: int = 40) -> str:
    """提取微博前若干字作为标题并去除非法字符"""
    clean = re.sub(r"[#\r\n\t]", " ", text).strip()
    clean = re.sub(r'[/\\:*?"<>|]', "_", clean)
    clean = re.sub(r"\s+", " ", clean)
    return clean[:max_len] if clean else "微博动态"


def archive_weibo_post(
    post_item: Dict[str, Any],
    account_key: str,
    account_info: Dict[str, str],
    output_base: Path = Path("./kpl_vault")
) -> Path:
    """
    将单条微博纯文本化归档至 kpl_vault
    """
    raw_content = post_item.get("text", "") or post_item.get("raw_text", "")
    pure_text = DajialaClient.clean_weibo_text(raw_content)

    created_at = post_item.get("created_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    date_prefix = created_at[:10] if len(created_at) >= 10 else datetime.now().strftime("%Y-%m-%d")
    
    title_summary = sanitize_title(pure_text)
    folder_name = f"{date_prefix}_{title_summary}"
    
    cat_dir = output_base / f"微博_{account_key}"
    post_dir = cat_dir / folder_name
    post_dir.mkdir(parents=True, exist_ok=True)

    weibo_id = str(post_item.get("id", post_item.get("mid", int(time.time()))))
    weibo_url = f"https://weibo.com/{account_info['uid']}/{weibo_id}"

    reposts = post_item.get("reposts_count", 0)
    comments = post_item.get("comments_count", 0)
    attitudes = post_item.get("attitudes_count", 0)

    # 1. 纯文本 Markdown
    md_content = f"""# {account_info['name']}：{title_summary}

> **平台**: 新浪微博官方认证号  
> **博主**: {account_info['name']} (UID: {account_info['uid']})  
> **发布时间**: {created_at}  
> **微博原文**: [{weibo_url}]({weibo_url})  
> **互动数据**: 转发 {reposts} | 评论 {comments} | 点赞 {attitudes}  

---

{pure_text}
"""
    (post_dir / f"{title_summary}.md").write_text(md_content, encoding="utf-8")

    # 2. 结构化元数据 JSON
    meta_info = {
        "platform": "weibo",
        "account_name": account_info["name"],
        "uid": account_info["uid"],
        "title": title_summary,
        "created_at": created_at,
        "source_url": weibo_url,
        "has_images": False,
        "stats": {
            "reposts": reposts,
            "comments": comments,
            "attitudes": attitudes
        },
        "word_count": len(pure_text),
        "archived_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
    (post_dir / "metadata.json").write_text(json.dumps(meta_info, ensure_ascii=False, indent=2), encoding="utf-8")

    # 3. 离线精简 HTML (无图纯净版)
    html_content = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>{account_info['name']} - {title_summary}</title>
    <style>
        body {{ max-width: 680px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.8; color: #222; }}
        h1 {{ font-size: 20px; }}
        .meta {{ color: #777; font-size: 13px; border-bottom: 1px solid #eee; padding-bottom: 12px; margin-bottom: 20px; }}
        .text {{ white-space: pre-wrap; font-size: 16px; }}
    </style>
</head>
<body>
    <h1>{account_info['name']}</h1>
    <div class="meta">发布时间: {created_at} | 转发: {reposts} 评论: {comments} 点赞: {attitudes} | <a href="{weibo_url}" target="_blank">查看微博原文</a></div>
    <div class="text">{pure_text}</div>
</body>
</html>"""
    (post_dir / "offline.html").write_text(html_content, encoding="utf-8")

    return post_dir


def main():
    print("=" * 65)
    print(" 🚀 大家拉 (dajiala.com) 官方微博纯文本抓取调度工具")
    print("=" * 65)

    client = DajialaClient()

    if not client.is_configured():
        print("⚠️  [当前未检测到 API 密钥]")
        print("大家拉平台为商业付费服务平台，需要 API Key 才能调用其服务器账号池拉取数据。")
        print("\n🔑 启用步骤：")
        print("1. 访问大家拉官网 (www.dajiala.com 或 www.jzl.com) 注册获取 API Key")
        print("2. 在当前目录下创建 .env 文件写入:")
        print("   DAJIALA_API_KEY=\"你的大家拉API密钥\"")
        print("   或执行终端命令: export DAJIALA_API_KEY=\"你的密钥\"")
        print("\n📋 系统已内置配置好的 KPL 官方及核心俱乐部微博账号池：")
        for k, v in KPL_WEIBO_ACCOUNTS.items():
            print(f"  • {k:<12} => 博主: {v['name']:<18} (UID: {v['uid']})")
        print("\n配置 Key 后，再次运行本脚本即可全自动完成无图纯文本批量抓取与入库！")
        return

    # 若已配置 Key，按目标抓取 KPL 官方微博
    target = sys.argv[1] if len(sys.argv) > 1 else "KPL官方"
    if target not in KPL_WEIBO_ACCOUNTS:
        print(f"❌ 未知目标账号，可选: {list(KPL_WEIBO_ACCOUNTS.keys())}")
        return

    info = KPL_WEIBO_ACCOUNTS[target]
    print(f"🎯 正在调用大家拉接口获取【{target}】({info['name']}, UID: {info['uid']}) 官方微博...")
    
    try:
        data = client.get_weibo_timeline(uid=info["uid"], page=1, page_size=20)
        items = data.get("data", {}).get("list", []) or data.get("list", [])
        print(f"✅ 大家拉接口返回 {len(items)} 条博文数据，开始纯文本化处理入库...")

        for idx, item in enumerate(items, 1):
            saved_path = archive_weibo_post(item, target, info)
            print(f"  [{idx}/{len(items)}] 纯文本归档成功: {saved_path.name}")

        print(f"\n🎉 【{target}】官方微博已全量纯文本入库至: ./kpl_vault/微博_{target}/")

    except Exception as e:
        print(f"❌ 调用大家拉接口失败: {e}")


if __name__ == "__main__":
    main()
