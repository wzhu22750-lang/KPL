#!/usr/bin/env node
/**
 * kpl_vault 精选知识库批量导入与实体关联脚本
 * - 扫描并读取 kpl_vault 下的高质量精选长文 (metadata.json + .md + .html)
 * - 自动关联对应官方/战队信源，以真实发布时间入库
 * - 生成正文 HTML，记录 entity_mentions 实体提及
 * - 自动发布并生成 publications 记录
 */
import fs from "node:fs/promises";
import path from "node:path";
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { upsertMaterial } from "../packages/backend/src/content/materials.ts";
import { markdownBody } from "../packages/backend/src/content/markdown.ts";
import { recordArticleEntityMentions } from "../packages/backend/src/kb/entity-mentions.ts";
import { publishArticle } from "../packages/backend/src/publication/publish.ts";
import { cleanWechatHtml } from "../packages/backend/src/sources/wechat2rss/parser.ts";

interface Metadata {
  title: string;
  author: string;
  publish_time: string;
  source_url: string;
  markdown_file: string;
  word_count?: number;
  archived_at?: string;
  has_images?: boolean;
}

export interface ImportVaultResult {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  errors: Array<{ path: string; error: string }>;
}

export async function importVault(options: { vaultDir?: string; dryRun?: boolean } = {}): Promise<ImportVaultResult> {
  const vaultDir = options.vaultDir || path.resolve(process.cwd(), "../kpl_vault");
  const dryRun = options.dryRun || false;

  console.log(`📂 开始扫描 kpl_vault 知识库目录: ${vaultDir} (dryRun: ${dryRun})`);

  const result: ImportVaultResult = {
    total: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  let subDirs: string[] = [];
  try {
    subDirs = await fs.readdir(vaultDir);
  } catch (err) {
    console.error(`无法读取 vault 目录: ${vaultDir}`, err);
    return result;
  }

  for (const catDir of subDirs) {
    const catPath = path.join(vaultDir, catDir);
    const catStat = await fs.stat(catPath).catch(() => null);
    if (!catStat || !catStat.isDirectory()) continue;

    const articleDirs = await fs.readdir(catPath);
    for (const artDir of articleDirs) {
      const artPath = path.join(catPath, artDir);
      const artStat = await fs.stat(artPath).catch(() => null);
      if (!artStat || !artStat.isDirectory()) continue;

      const metaPath = path.join(artPath, "metadata.json");
      result.total++;

      try {
        const metaRaw = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaRaw) as Metadata;

        if (!meta.title || !meta.source_url) {
          result.failed++;
          result.errors.push({ path: artPath, error: "metadata.json 缺少 title 或 source_url" });
          continue;
        }

        // 读取 Markdown 正文
        const mdPath = path.join(artPath, meta.markdown_file);
        let mdText = "";
        try {
          mdText = await fs.readFile(mdPath, "utf-8");
        } catch {
          result.failed++;
          result.errors.push({ path: artPath, error: `未找到对应 markdown 文件: ${meta.markdown_file}` });
          continue;
        }

        // 尝试读取 offline.html 或由 markdown 生成 html
        let htmlBody = "";
        const offlineHtmlPath = path.join(artPath, "offline.html");
        try {
          const rawHtml = await fs.readFile(offlineHtmlPath, "utf-8");
          const cleaned = cleanWechatHtml(rawHtml);
          if (cleaned.html && cleaned.html.length > 100) {
            htmlBody = cleaned.html;
          }
        } catch {
          // offline.html 不存在时用 markdown 生成
        }

        if (!htmlBody) {
          htmlBody = markdownBody(mdText, meta.source_url);
        }

        // 判定关联信源
        let sourceId = "mp-kpl-official";
        if (catDir.includes("AG")) sourceId = "mp-ag";
        else if (catDir.includes("DYG")) sourceId = "mp-dyg";
        else if (catDir.includes("狼队")) sourceId = "mp-wolves";
        else if (catDir.includes("KSG")) sourceId = "mp-ksg";
        else if (catDir.includes("Hero")) sourceId = "mp-hero";
        else if (catDir.includes("TTG")) sourceId = "mp-ttg";
        else if (catDir.includes("WB")) sourceId = "mp-wb";
        else if (catDir.includes("eStar")) sourceId = "mp-estar";
        else if (catDir.includes("DRG")) sourceId = "mp-drg";

        // 确保对应信源在数据库中存在
        const [src] = await sql<{ id: string }[]>`SELECT id FROM sources WHERE id = ${sourceId}`;
        if (!src) {
          await sql`
            INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${sourceId}, ${catDir}, 'mp_account', 'T1', 'editorial', true, true, now())
            ON CONFLICT (id) DO NOTHING
          `;
        }

        const pubDate = meta.publish_time ? new Date(meta.publish_time.replace(" ", "T") + "+08:00") : new Date();

        if (dryRun) {
          console.log(`  [DRY-RUN] 拟入库 [${sourceId}] ${meta.title} (${pubDate.toISOString().slice(0, 10)}) - ${meta.word_count || mdText.length} 字`);
          result.imported++;
          continue;
        }

        // 入库
        const res = await upsertMaterial({
          sourceId,
          url: meta.source_url,
          title: meta.title,
          author: meta.author || "KPL",
          language: "zh",
          publishedAt: pubDate,
          excerpt: mdText.slice(0, 300).replace(/^[#\s>*-]+/gm, ""),
          bodyHtml: htmlBody,
          bodyText: mdText,
          bodyStatus: "ok",
          via: "import",
          backfill: "kpl-vault",
        });

        // 抽取并记录实体
        await recordArticleEntityMentions(res.articleId, meta.title + "\n\n" + mdText);

        // 确保 publications 记录就绪
        await publishArticle(res.articleId);

        console.log(`  ✅ 成功导入 [${sourceId}] ${meta.title} (${pubDate.toISOString().slice(0, 10)}) -> ID: ${res.articleId}`);
        result.imported++;
      } catch (err) {
        result.failed++;
        result.errors.push({ path: artPath, error: String(err instanceof Error ? err.message : err) });
        console.error(`  ❌ 导入失败: ${artPath}`, err);
      }
    }
  }

  console.log(`\n📊 知识库导入完毕: 总数 ${result.total}, 成功 ${result.imported}, 跳过 ${result.skipped}, 失败 ${result.failed}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let vaultDir = "";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" && args[i + 1]) vaultDir = args[++i]!;
    if (args[i] === "--dry-run") dryRun = true;
  }

  if (!vaultDir) {
    vaultDir = path.resolve(process.cwd(), "../kpl_vault");
  }

  try {
    await importVault({ vaultDir, dryRun });
  } finally {
    await closeDb();
  }
}
