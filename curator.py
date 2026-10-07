#!/usr/bin/env python3
"""
KPL 官方及俱乐部文章高质量初筛与入库质检系统 (Quality Gatekeeper)
================================================================
质检与初筛标准：
1. 【硬性剔除】
   - 严禁非 KPL 项目混入（如英雄联盟S赛、穿越火线CFS、QQ飞车S联赛、台球、无畏契约、街霸格斗等）
   - 严禁纯商业外挂广告或无意义的售票跳转短讯
   - 空正文、明显垃圾及纯广告；不以字数替代质量
2. 【正向准入】
   - 必须紧密围绕 KPL 职业联赛、总决赛、银龙杯、年度总决赛、世冠杯、挑战者杯
   - 规则只检查相关性，LLM 六维评分负责专业编辑判断
   - 基础归档元数据增量保存评分、内容类型与评价
3. 【精细归档】
   - 归档至 clean 的 ./kpl_vault/ 目录，按战队细分
   - 生成AUDIT_REPORT.md（质检审计报告）与INDEX.md（总目录）
"""

import json
import shutil
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from bs4 import BeautifulSoup
from curl_cffi import requests

from kpl_scraper import extract_publish_time, process_wechat_html, scrape_article
from quality_scoring import (
    QualityScoringError,
    build_quality_input,
    content_fingerprint,
    normalize_quality_result,
    quality_metadata,
    score_article,
)

SOURCE_JSON = Path("discovered_urls.json")
VAULT_DIR = Path("./kpl_vault")

# 明确的非KPL干扰项黑名单关键词
STRICT_EXCLUDE_KEYWORDS = [
    "穿越火线",
    "CFS",
    "CFML",
    "CFPL",
    "穿越火线手游",
    "英雄联盟",
    "LPL",
    "LCK",
    "MSI",
    "DK夺冠",
    "EDG力克DK",
    "无畏契约",
    "VALORANT",
    "大师赛",
    "皇室战争",
    "CRL",
    "Team Queso",
    "QQ飞车",
    "S联赛",
    "台球锦标赛",
    "星际争霸",
    "游戏王",
    "卡普空",
    "格斗分部",
    "高校联赛",
    "雷神杯",
    "苏超",
]

# KPL 核心正向特征
KPL_CORE_ENTITIES = [
    "KPL",
    "王者荣耀职业联赛",
    "银龙杯",
    "KIC",
    "王者荣耀世界冠军杯",
    "挑战者杯",
    "成都AG",
    "AG超玩会",
    "重庆狼队",
    "QGhappy",
    "武汉eStar",
    "eStarPro",
    "广州TTG",
    "北京WB",
    "南京Hero",
    "Hero久竞",
    "苏州KSG",
    "佛山DRG",
    "深圳DYG",
    "一诺",
    "徐必成",
    "小胖",
    "李达亨",
    "Fly",
    "彭云飞",
    "花海",
    "罗思源",
    "清融",
    "黄垚钦",
    "钎城",
    "周诣涛",
    "钟意",
    "陈家豪",
    "大帅",
    "孟家俊",
]


def evaluate_article_rules(title: str, author: str, text: str) -> tuple[bool, str, str, str]:
    """规则粗筛；返回 (是否继续AI评分, 原因, 战队目录, 旧标签)。"""
    clean_text = text.strip()

    # 短文章不等于低质量；只拦无正文和明显异常字符填充。
    if not clean_text:
        return False, "正文为空/页面异常", "未分类", "异常页面"
    if len(set(clean_text)) <= 2:
        return False, "正文为无意义字符填充", "未分类", "垃圾内容"
    if any(k in title for k in ["优惠券领取", "下单购买", "博彩投注", "代练接单"]):
        return False, "纯广告/垃圾推广", "未分类", "广告"

    # 2. 检查排他性黑名单（其他电竞赛事污染）
    for excl in STRICT_EXCLUDE_KEYWORDS:
        if excl in title:
            return False, f"标题命中非KPL赛事关键词: 【{excl}】", "未分类", "其他赛事"
        if text.count(excl) >= 4 and not any(k in title for k in ["KPL", "王者荣耀"]):
            return False, f"正文主要报道其他电竞赛事 ({excl} 出现多达 {text.count(excl)} 次)", "未分类", "其他赛事"

    # 3. 检查 KPL 相关度
    kpl_hit_count = sum(clean_text.count(e) for e in KPL_CORE_ENTITIES)
    if kpl_hit_count < 1 and "KPL" not in title and "王者荣耀" not in title:
        return False, f"KPL 核心实体关联度极弱 (仅命中 {kpl_hit_count} 次)", "未分类", "泛电竞"

    # 4. 战队精细归类
    category = "KPL官方与联盟综述"
    tag = "深度赛事报道"

    if any(k in title or clean_text.count(k) >= 8 for k in ["成都AG", "AG超玩会", "一诺"]):
        category = "成都AG超玩会"
    elif any(k in title or clean_text.count(k) >= 8 for k in ["重庆狼队", "狼队", "小胖", "Fly", "QGhappy"]):
        category = "重庆狼队"
    elif any(k in title or clean_text.count(k) >= 8 for k in ["武汉eStar", "eStarPro", "花海"]):
        category = "武汉eStarPro"
    elif any(k in title or clean_text.count(k) >= 8 for k in ["广州TTG", "TTG", "钎城", "九尾"]):
        category = "广州TTG"
    elif any(k in title or clean_text.count(k) >= 8 for k in ["北京WB", "WB战队", "暖阳"]):
        category = "北京WB"
    elif any(k in title or clean_text.count(k) >= 8 for k in ["南京Hero", "Hero久竞", "久哲"]):
        category = "南京Hero久竞"
    elif any(k in title or clean_text.count(k) >= 8 for k in ["苏州KSG", "KSG战队"]):
        category = "苏州KSG"
    elif any(k in title or clean_text.count(k) >= 8 for k in ["佛山DRG", "DRG战队"]):
        category = "佛山DRG"
    elif any(k in title or clean_text.count(k) >= 8 for k in ["深圳DYG", "DYG战队"]):
        category = "深圳DYG"

    # 5. 标签判定
    if any(k in title for k in ["决赛", "总决赛", "开赛", "赛程", "战报"]):
        tag = "官方决战与赛程"
    elif any(k in title for k in ["夺冠", "六连冠", "冠军"]):
        tag = "冠军荣耀与表彰"
    elif any(k in title for k in ["专访", "切面人生", "选手", "教练", "触乐"]):
        tag = "深度特稿与人物专访"
    elif any(k in title for k in ["主场", "城市", "鸟巢", "高新区"]):
        tag = "主场地标与产业"

    return True, "规则粗筛通过，尚需AI价值评分", category, tag


def evaluate_article_quality(
    title: str, author: str, text: str, *, quality_result: dict[str, Any] | None = None,
) -> tuple[bool, str, str, str]:
    """保留旧四元组接口；未提供评分时不能凭规则直接入选。"""
    ok, reason, category, tag = evaluate_article_rules(title, author, text)
    if not ok:
        return ok, reason, category, tag
    if quality_result is None:
        return False, "缺少AI价值评分，待复核", category, tag
    result = normalize_quality_result(quality_result)
    return result["should_curate"], result["reason"], category, tag


async def assess_article(
    title: str, author: str, text: str, *, source_url: str = "", publish_time: str = "",
    duplicate: bool = False, scorer: Callable[..., Awaitable[dict[str, Any]]] = score_article,
    evaluated_at: str | None = None,
) -> dict[str, Any]:
    ok, reason, category, tag = evaluate_article_rules(title, author, text)
    decision = {"category": category, "tag": tag, "reason": reason, "status": "rejected", "quality": None}
    if not ok:
        return decision
    material = dict(title=title, author=author, text=text, source_url=source_url,
                    publish_time=publish_time, duplicate=duplicate, evaluated_at=evaluated_at)
    try:
        build_quality_input(**material)  # Never silently score a truncated article.
        result = normalize_quality_result(await scorer(**material), duplicate=duplicate)
    except QualityScoringError as error:
        decision.update(status="pending_review", reason=f"{error}，未准入")
        return decision
    except Exception:
        # Never leak arbitrary provider errors or fall back to rule-only admission.
        decision.update(status="pending_review", reason="AI评分不可用或输出非法，待复核")
        return decision
    decision.update(quality=result, reason=result["reason"], status="passed" if result["should_curate"] else "rejected")
    return decision


def load_existing_vault() -> tuple[list[dict[str, Any]], dict[str, str]]:
    """保留旧库存和索引；用来源URL标识正文指纹的所有者。"""
    articles: list[dict[str, Any]] = []
    fingerprints: dict[str, str] = {}
    for path in sorted(VAULT_DIR.rglob("metadata.json")):
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
            url = meta["source_url"]
            fingerprint = meta.get("content_fingerprint")
            if not fingerprint:
                html_path = path.parent / "offline.html"
                if html_path.exists():
                    soup = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html.parser")
                    body = soup.select_one(".content")
                    if body:
                        fingerprint = content_fingerprint(body.get_text())
            if fingerprint:
                fingerprints[fingerprint] = url
            articles.append({"path": str(path.parent), "meta": meta,
                             "curated_category": path.parent.parent.name, "tag": meta.get("tag", "历史精选")})
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return articles, fingerprints


def save_quality_metadata(res: dict[str, Any], result: dict[str, Any], text: str, category: str, tag: str):
    meta = res["meta"]
    meta.update(quality_metadata(result, text), curated_category=category, tag=tag)
    path = Path(res["path"]) / "metadata.json"
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def extract_candidate_urls(data: dict) -> list[str]:
    """从 discovered_urls.json 的结构中取出候选 URL。

    兼容两种条目形态：纯 URL 字符串（旧格式），或含 url 字段的元信息 dict
    （dajiala_client.py --export-json 的产物）。空值与非列表值直接忽略。
    """
    urls: list[str] = []
    for items in data.values():
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, str):
                url = item.strip()
            elif isinstance(item, dict):
                url = str(item.get("url") or "").strip()
            else:
                continue
            if url:
                urls.append(url)
    return urls


async def run_quality_curation(*, scorer: Callable[..., Awaitable[dict[str, Any]]] = score_article):
    print("=" * 65)
    print(" 🛡️  KPL 微信公众号数据资产：AI 深度质检初筛与入库流程启动")
    print("=" * 65)

    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    existing, fingerprints = load_existing_vault()
    indexed = {item["meta"]["source_url"]: item for item in existing}

    # 汇总待审查的候选 URL
    candidates = []
    if SOURCE_JSON.exists():
        with open(SOURCE_JSON, encoding="utf-8") as f:
            candidates.extend(extract_candidate_urls(json.load(f)))

    # 加上之前已抓取到的所有 URL
    for p in Path("kpl_articles").rglob("metadata.json"):
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
            candidates.append(m["source_url"])
        except Exception:
            pass

    # 去重
    candidates = list(dict.fromkeys(candidates))
    print(f"📊 待审查池总计: {len(candidates)} 篇候选文章\n")

    passed_list = []
    rejected_list = []

    for idx, url in enumerate(candidates, 1):
        print(f"[{idx}/{len(candidates)}] 审查中: {url}")
        try:
            resp = requests.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
                impersonate="chrome124",
                timeout=12,
            )
            if resp.status_code != 200:
                rejected_list.append(
                    {
                        "url": url,
                        "title": "页面异常/已删除",
                        "author": "-",
                        "status": "rejected",
                        "reason": f"HTTP {resp.status_code} 或未能获取到正文",
                    }
                )
                print("  ❌ 淘汰: 页面异常/已删除\n")
                continue

            soup = BeautifulSoup(resp.text, "html.parser")
            title_el = soup.select_one("#activity-name")
            author_el = soup.select_one("#js_name")
            content_el = soup.select_one("#js_content")

            title = title_el.get_text(strip=True) if title_el else "无标题"
            author = author_el.get_text(strip=True) if author_el else "未知公众号"
            # Use the scraper's canonical cleaning so ads/media removed during download
            # do not look like a changed article on the second fetch.
            text = ""
            if content_el:
                parsed = process_wechat_html(resp.text)
                text = BeautifulSoup(parsed["raw_content_html"], "html.parser").get_text()
                title, author = parsed["title"], parsed["author"]
            fingerprint = content_fingerprint(text)
            decision = await assess_article(
                title, author, text, source_url=url, publish_time=extract_publish_time(resp.text),
                duplicate=fingerprint in fingerprints and fingerprints[fingerprint] != url, scorer=scorer,
            )
            category, tag, reason = decision["category"], decision["tag"], decision["reason"]
            if decision["status"] != "passed":
                rejected_list.append({"url": url, "title": title, "author": author, **decision})
                print(f"  ❌ 未准入: {title[:28]}... ({reason})\n")
                continue

            # 二次抓取暂存在库外：失败或正文变化不得产生未经质检的精选目录。
            with TemporaryDirectory(prefix="kpl-curation-", dir=VAULT_DIR.parent) as staging:
                res = await scrape_article(url, output_base=Path(staging))
                if res.get("status") != "ok":
                    rejected_list.append({"url": url, "title": title, "author": author,
                                          "status": "pending_review", "reason": "归档下载失败，待复核"})
                    continue
                staged_path = Path(res["path"])
                archived = BeautifulSoup((staged_path / "offline.html").read_text(encoding="utf-8"), "html.parser")
                archived_body = archived.select_one(".content")
                if (not archived_body or content_fingerprint(archived_body.get_text()) != fingerprint
                        or res["meta"].get("title") != title or res["meta"].get("author") != author):
                    rejected_list.append({"url": url, "title": title, "author": author,
                                          "status": "pending_review",
                                          "reason": "二次抓取正文/标题/作者变化，需重新评分"})
                    continue
                save_quality_metadata(res, decision["quality"], text, category, tag)
                target = VAULT_DIR / category / staged_path.name
                target.parent.mkdir(parents=True, exist_ok=True)
                # A title/date collision must not overwrite a different source's existing assets.
                if target.exists():
                    target_meta = json.loads((target / "metadata.json").read_text(encoding="utf-8"))
                    if target_meta.get("source_url") != url:
                        target = target.with_name(f"{target.name}_{fingerprint[:12]}")
                if target.exists():
                    shutil.copytree(staged_path, target, dirs_exist_ok=True)
                else:
                    staged_path.replace(target)  # Same-filesystem atomic publication for new articles.
                res.update(path=str(target), curated_category=category, tag=tag)
                fingerprints[fingerprint] = url
                indexed[url] = res
                passed_list.append(res)
                print(f"  ✅ 准入: 【{category}】 {title[:28]} ({decision['quality']['quality_score']}分)\n")

        except Exception as e:
            rejected_list.append({"url": url, "title": "抓取解析失败", "author": "-",
                                  "status": "pending_review", "reason": "抓取或归档异常，待复核"})
            print(f"  ❌ 异常: {e}\n")

    print("\n" + "=" * 65)
    pending_count = sum(item.get("status") == "pending_review" for item in rejected_list)
    print(f"🎉 质检完毕！准入: {len(passed_list)} 篇 | 拒绝: {len(rejected_list) - pending_count} 篇 "
          f"| 待复核: {pending_count} 篇")
    print("=" * 65)

    # 生成审计报告与总库索引
    generate_audit_and_index(list(indexed.values()), rejected_list)
    (VAULT_DIR / "QUALITY_AUDIT.json").write_text(json.dumps({
        "evaluated_at": datetime.now().isoformat(),
        "passed": [{"url": item["meta"]["source_url"], "meta": item["meta"]} for item in passed_list],
        "rejected_or_pending": rejected_list,
    }, ensure_ascii=False, indent=2), encoding="utf-8")


def generate_audit_and_index(passed: list[dict[str, Any]], rejected: list[dict[str, Any]]):
    """生成正式入库大纲与质检审计报告"""
    # 1. 生成 INDEX.md
    index_lines = [
        "# 🏆 KPL 官方及各大俱乐部微信文章·精选高质量知识库 (KPL Vault)",
        "",
        f"> **质检完成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ",
        "> **质检状态**: 新准入执行规则粗筛＋AI价值评分；历史精选未评分的保留原状  ",
        f"> **入库文章数**: **{len(passed)}** 篇精选深度文章  ",
        f"> **本次未准入数**: **{len(rejected)}** 篇（含技术失败待复核，不均属低质内容）  ",
        "",
        "---",
        "",
        "## 📚 精选文章总目录",
        "",
    ]

    # 按分类聚合
    cat_dict: dict[str, list[dict[str, Any]]] = {}
    for p in passed:
        c = p.get("curated_category", "其他")
        cat_dict.setdefault(c, []).append(p)

    for cat, items in cat_dict.items():
        index_lines.append(f"### 📍 {cat} ({len(items)} 篇)")
        index_lines.append("")
        index_lines.append("| 发布时间 | 标签 | 标题 | 公众号 | 字数 | 图片 | 离线查看 | 微信原文 | 价值分 | 类型 |")
        index_lines.append("| :--- | :---: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |")

        for it in items:
            meta = it.get("meta", {})
            pub = meta.get("publish_time", "-")[:10]
            tag = it.get("tag", "精选")
            title = meta.get("title", "未命名")
            author = meta.get("author", "官方")
            words = meta.get("word_count", 0)
            imgs = meta.get("downloaded_images", 0)
            src_url = meta.get("source_url", "")

            folder = Path(it["path"]).name
            md_name = meta.get("markdown_file", "")
            md_link = f"[{title}](./{cat}/{folder}/{md_name})"
            offline_link = f"[离线HTML](./{cat}/{folder}/offline.html)"
            src_link = f"[原文]({src_url})" if src_url else "-"

            index_lines.append(
                f"| {pub} | `{tag}` | {md_link} | {author} | {words}字 | {imgs}张 | {offline_link} | {src_link} "
                f"| {meta.get('quality_score', '未评分')} | {meta.get('content_category', '历史精选')} |"
            )
        index_lines.append("")

    (VAULT_DIR / "INDEX.md").write_text("\n".join(index_lines), encoding="utf-8")

    # 2. 生成 AUDIT_REPORT.md
    audit_lines = [
        "# 🛡️ 微信公众号文章抓取质量初筛与审计报告",
        "",
        "## 一、 审查准则与执行标准",
        "1. **赛事专注度**：坚决剔除穿越火线、英雄联盟、台球、无畏契约、皇室战争、QQ飞车等非王者荣耀/KPL内容；",
        "2. **内容价值**：按类型加权六维评分，代码校验准入；不以800字或关键词频率替代质量；",
        "3. **失败关闭**：模型失败/非法输出/二次抓取变化待复核，详见 QUALITY_AUDIT.json；",
        "4. **历史兼容**：既有文章保留，本次不会自动删除或重评未提供的历史候选；",
        "",
        "## 二、 未准入与待复核明细 (模型评价详见 QUALITY_AUDIT.json)",
        f"本次共 **{len(rejected)}** 篇未准入；其中模型/采集/归档失败须复核，不表示内容低质：",
        "",
        "| 序号 | 标题 | 公众号 | 淘汰原因 | 原文链接 |",
        "| :---: | :--- | :--- | :--- | :--- |",
    ]

    for i, r in enumerate(rejected, 1):
        audit_lines.append(
            f"| {i} | {r.get('title', '未知')[:30]} | {r.get('author', '-')} "
            f"| `{r.get('reason', '-')}` | [链接]({r.get('url', '')}) |"
        )

    (VAULT_DIR / "AUDIT_REPORT.md").write_text("\n".join(audit_lines), encoding="utf-8")
    print(f"📄 审计报告已写入: {VAULT_DIR / 'AUDIT_REPORT.md'}")
    print(f"📄 精选总库索引已写入: {VAULT_DIR / 'INDEX.md'}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_quality_curation())
