#!/usr/bin/env node
/**
 * WeChat2RSS CLI 工具
 * 作用：无需付费 Key，将任意微信公众号转换为标准 RSS 2.0 XML 或在终端预览
 *
 * 用法：
 *   node --env-file-if-exists=.env scripts/wechat2rss-cli.ts "KPL王者荣耀职业联赛"
 *   node --env-file-if-exists=.env scripts/wechat2rss-cli.ts "王者荣耀" --preview
 *   node --env-file-if-exists=.env scripts/wechat2rss-cli.ts "KPL" --search
 *   node --env-file-if-exists=.env scripts/wechat2rss-cli.ts "KPL王者荣耀职业联赛" --output=kpl.xml
 */
import { writeFileSync } from "node:fs";
import { wechatBridge } from "@aihot/backend/sources/wechat2rss/index";

const args = process.argv.slice(2);
const searchMode = args.includes("--search");
const previewMode = args.includes("--preview");
const jsonMode = args.includes("--json");
const outputArg = args.find((a) => a.startsWith("--output="));
const outputFile = outputArg ? outputArg.split("=")[1] : null;

const accountArg = args.find((a) => !a.startsWith("--"));

if (!accountArg) {
  console.log(`
WeChat2RSS CLI - 微信公众号免 Key 转 RSS 工具

用法:
  node scripts/wechat2rss-cli.ts <公众号名称/微信号/别名> [选项]

选项:
  --preview          在终端预览抓取到的文章列表及正文摘要
  --search           搜索公众号
  --json             以 JSON 格式输出
  --output=<path>    保存 RSS XML 到指定文件

示例:
  node scripts/wechat2rss-cli.ts "KPL王者荣耀职业联赛" --preview
  node scripts/wechat2rss-cli.ts "王者荣耀" --output=dist/hok.xml
  node scripts/wechat2rss-cli.ts "KPL" --search
`);
  process.exit(0);
}

async function main() {
  if (searchMode) {
    console.log(`🔍 正在搜索公众号: "${accountArg}" ...`);
    const results = await wechatBridge.search(accountArg);
    if (results.length === 0) {
      console.log("❌ 未搜索到匹配的公众号");
      return;
    }
    console.log(`✅ 找到 ${results.length} 个公众号:\n`);
    for (const item of results) {
      console.log(`📌 名称: ${item.name}`);
      console.log(`   ID: ${item.id}`);
      if (item.description) console.log(`   简介: ${item.description}`);
      if (item.url) console.log(`   链接: ${item.url}`);
      console.log("   ---");
    }
    return;
  }

  console.log(`📡 正在抓取公众号: "${accountArg}" ...`);
  const result = await wechatBridge.fetchAccountArticles(accountArg, { force: true });

  if (!result || result.articles.length === 0) {
    console.log(`❌ 未能抓取到公众号 "${accountArg}" 的文章，请检查名称是否正确`);
    return;
  }

  console.log(`✅ 成功获取公众号 [${result.account.name}] 的文章 (共 ${result.articles.length} 篇)\n`);

  if (previewMode) {
    for (let i = 0; i < result.articles.length; i++) {
      const art = result.articles[i]!;
      console.log(`[${i + 1}] ${art.title}`);
      console.log(`    发布时间: ${art.publishedAt.toLocaleString("zh-CN")}`);
      console.log(`    作者: ${art.author || result.account.name}`);
      console.log(`    链接: ${art.url}`);
      if (art.coverUrl) console.log(`    封面: ${art.coverUrl}`);
      console.log(`    摘要: ${art.description?.slice(0, 100) || "无"}...`);
      console.log("    ----------------------------------------");
    }
  }

  if (jsonMode) {
    const json = await wechatBridge.getJsonFeed(accountArg);
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  const xml = await wechatBridge.getRssXml(accountArg);

  if (outputFile) {
    writeFileSync(outputFile, xml, "utf8");
    console.log(`💾 已将 RSS XML 写入文件: ${outputFile}`);
  } else if (!previewMode) {
    console.log("--- RSS 2.0 XML 输出预览 (前 500 字符) ---");
    console.log(xml.slice(0, 500) + "\n...\n");
    console.log(`💡 提示: 加上 --output=feed.xml 可导出完整 XML，或在系统中配置 RSS feedUrl 使用。`);
  }
}

main().catch((err) => {
  console.error("运行失败:", err);
  process.exit(1);
});
