#!/usr/bin/env node
/**
 * kpl_vault 精选知识库批量导入与实体关联脚本
 * - 扫描并读取 kpl_vault 下的高质量精选长文 (metadata.json + .md + .html)
 * - 自动关联对应官方/战队信源，以真实发布时间入库
 * - 生成正文 HTML，记录 entity_mentions 实体提及
 * - 自动发布并生成 publications 记录
 * - 严格支持 --dry-run (绝对零写库)，支持幂等性 (已存在文章自动跳过)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { identityKeyForUrl } from "../packages/backend/src/lib/url.ts";
import { upsertMaterial } from "../packages/backend/src/content/materials.ts";
import { markdownBody } from "../packages/backend/src/content/markdown.ts";
import { recordArticleEntityMentions } from "../packages/backend/src/kb/entity-mentions.ts";
import { publishArticle } from "../packages/backend/src/publication/publish.ts";
import { cleanWechatHtml } from "../packages/backend/src/sources/wechat2rss/parser.ts";
import { pruneHtmlNoise, pruneTextNoise } from "../packages/backend/src/content/clean-noise.ts";

export interface Metadata {
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

export function parsePublishDate(publishTime?: string): Date | null {
  if (!publishTime || typeof publishTime !== "string") return null;
  const trimmed = publishTime.trim();
  if (!trimmed) return null;
  // 支持 "2025-11-10 20:35:26" 或带 T 的 ISO 字符串，默认补充东八区 +08:00
  const isoStr = trimmed.includes("T")
    ? (trimmed.includes("+") || trimmed.endsWith("Z") ? trimmed : trimmed + "+08:00")
    : trimmed.replace(" ", "T") + "+08:00";
  const date = new Date(isoStr);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function resolveVaultSourceId(catDir: string): string {
  if (catDir.includes("AG")) return "mp-ag";
  if (catDir.includes("DYG")) return "mp-dyg";
  if (catDir.includes("狼队")) return "mp-wolves";
  if (catDir.includes("KSG")) return "mp-ksg";
  if (catDir.includes("Hero")) return "mp-hero";
  if (catDir.includes("TTG")) return "mp-ttg";
  if (catDir.includes("WB")) return "mp-wb";
  if (catDir.includes("eStar")) return "mp-estar";
  if (catDir.includes("DRG")) return "mp-drg";
  return "mp-kpl-official";
}

export function validateVaultMetadata(meta: unknown): { valid: boolean; error?: string; metadata?: Metadata } {
  if (!meta || typeof meta !== "object") {
    return { valid: false, error: "metadata 内容非有效 JSON 对象" };
  }
  const m = meta as Record<string, unknown>;
  if (!m.title || typeof m.title !== "string" || m.title.trim() === "") {
    return { valid: false, error: "缺少有效 title" };
  }
  if (!m.source_url || typeof m.source_url !== "string") {
    return { valid: false, error: "缺少有效 source_url" };
  }
  try {
    const u = new URL(m.source_url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { valid: false, error: `source_url 协议非法: ${m.source_url}` };
    }
  } catch {
    return { valid: false, error: `source_url 格式非法: ${m.source_url}` };
  }
  if (!m.markdown_file || typeof m.markdown_file !== "string") {
    return { valid: false, error: "缺少有效 markdown_file 字段" };
  }
  const normalized = path.normalize(m.markdown_file);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return { valid: false, error: `markdown_file 路径存在安全越界风险: ${m.markdown_file}` };
  }
  return { valid: true, metadata: m as unknown as Metadata };
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

  // 排序确保稳定执行顺序
  subDirs.sort();

  for (const catDir of subDirs) {
    const catPath = path.join(vaultDir, catDir);
    const catStat = await fs.stat(catPath).catch(() => null);
    if (!catStat || !catStat.isDirectory()) continue;

    const articleDirs = await fs.readdir(catPath);
    articleDirs.sort();

    for (const artDir of articleDirs) {
      const artPath = path.join(catPath, artDir);
      const artStat = await fs.stat(artPath).catch(() => null);
      if (!artStat || !artStat.isDirectory()) continue;

      const metaPath = path.join(artPath, "metadata.json");
      const metaStat = await fs.stat(metaPath).catch(() => null);
      if (!metaStat || !metaStat.isFile()) continue;

      result.total++;

      try {
        const metaRaw = await fs.readFile(metaPath, "utf-8");
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(metaRaw);
        } catch {
          result.failed++;
          result.errors.push({ path: artPath, error: "metadata.json 解析失败 (JSON 语法错误)" });
          continue;
        }

        const val = validateVaultMetadata(parsedJson);
        if (!val.valid || !val.metadata) {
          result.failed++;
          result.errors.push({ path: artPath, error: val.error || "元数据校验失败" });
          continue;
        }
        const meta = val.metadata;

        // 真实发布时间解析：杜绝使用当前抓取时间冒充发布时间
        const pubDate = parsePublishDate(meta.publish_time);
        if (!pubDate) {
          result.failed++;
          result.errors.push({ path: artPath, error: `缺少或无法解析真实 publish_time: "${meta.publish_time}"，拒绝污染时间线` });
          continue;
        }

        // 读取 Markdown 正文并自动剔除末尾无关广告与招聘
        const mdPath = path.join(artPath, meta.markdown_file);
        let mdText = "";
        try {
          const rawMd = await fs.readFile(mdPath, "utf-8");
          mdText = pruneTextNoise(rawMd);
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
            htmlBody = pruneHtmlNoise(cleaned.html);
          }
        } catch {
          // offline.html 不存在时用 markdown 生成
        }

        if (!htmlBody) {
          htmlBody = pruneHtmlNoise(markdownBody(mdText, meta.source_url));
        }

        // 判定关联信源
        const sourceId = resolveVaultSourceId(catDir);
        const identityKey = identityKeyForUrl(meta.source_url);

        // 如果是 dry-run 模式：绝对不向数据库执行任何写入操作
        if (dryRun) {
          console.log(`  [DRY-RUN] 拟入库 [${sourceId}] ${meta.title} (${pubDate.toISOString().slice(0, 10)}) - ${meta.word_count || mdText.length} 字`);
          result.imported++;
          continue;
        }

        // 正式运行：幂等性检查与断点恢复
        const [existing] = await sql<{ id: string }[]>`
          SELECT id FROM articles WHERE url = ${meta.source_url} OR identity_key = ${identityKey} LIMIT 1
        `;
        if (existing) {
          // 检查关联的 publications 与实体提及是否已创建；若中途失败缺失则补齐
          const [pub] = await sql<{ exists: boolean }[]>`
            SELECT EXISTS(SELECT 1 FROM publications WHERE article_id = ${existing.id}) AS exists
          `;
          const [mention] = await sql<{ exists: boolean }[]>`
            SELECT EXISTS(SELECT 1 FROM entity_mentions WHERE article_id = ${existing.id}) AS exists
          `;

          let recovered = false;
          if (!mention?.exists) {
            await recordArticleEntityMentions(existing.id, meta.title + "\n\n" + mdText);
            recovered = true;
          }
          if (!pub?.exists) {
            await publishArticle(existing.id);
            recovered = true;
          }

          if (recovered) {
            console.log(`  🔄 [RECOVERED] 文章已存在，已补齐缺失关联: [${existing.id}] ${meta.title}`);
            result.imported++;
          } else {
            console.log(`  ⏩ [SKIP] 文章已存在且关联完整，跳过: [${existing.id}] ${meta.title}`);
            result.skipped++;
          }
          continue;
        }

        // 确保对应信源在数据库中存在
        const [src] = await sql<{ id: string }[]>`SELECT id FROM sources WHERE id = ${sourceId}`;
        if (!src) {
          await sql`
            INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${sourceId}, ${catDir}, 'mp_account', 'T1', 'editorial', true, true, now())
            ON CONFLICT (id) DO NOTHING
          `;
        }

        // 写入材料表 (使用真实 pubDate，杜绝入库时间污染)
        const res = await upsertMaterial({
          sourceId,
          url: meta.source_url,
          identityKey: identityKey ?? undefined,
          title: meta.title,
          author: meta.author || "KPL",
          language: "zh",
          publishedAt: pubDate,
          discoveredAt: pubDate,
          excerpt: mdText.slice(0, 300).replace(/^[#\s>*-]+/gm, ""),
          bodyHtml: htmlBody,
          bodyText: mdText,
          bodyStatus: "ok",
          via: "import",
          backfill: "kpl-vault",
        });

        if (res.created) {
          // 抽取并记录实体
          await recordArticleEntityMentions(res.articleId, meta.title + "\n\n" + mdText);

          // 确保 publications 记录就绪
          await publishArticle(res.articleId);

          console.log(`  ✅ 成功导入 [${sourceId}] ${meta.title} (${pubDate.toISOString().slice(0, 10)}) -> ID: ${res.articleId}`);
          result.imported++;
        } else {
          // 未产生新文章修订，检查是否缺失关联并补齐
          const [pub] = await sql<{ exists: boolean }[]>`
            SELECT EXISTS(SELECT 1 FROM publications WHERE article_id = ${res.articleId}) AS exists
          `;
          const [mention] = await sql<{ exists: boolean }[]>`
            SELECT EXISTS(SELECT 1 FROM entity_mentions WHERE article_id = ${res.articleId}) AS exists
          `;
          let recovered = false;
          if (!mention?.exists) {
            await recordArticleEntityMentions(res.articleId, meta.title + "\n\n" + mdText);
            recovered = true;
          }
          if (!pub?.exists) {
            await publishArticle(res.articleId);
            recovered = true;
          }
          if (recovered) {
            console.log(`  🔄 [RECOVERED] 补齐关联 publications/实体: ID: ${res.articleId}`);
            result.imported++;
          } else {
            console.log(`  ⏩ [SKIP] 未产生新文章修订 (已存在且完整): ID: ${res.articleId}`);
            result.skipped++;
          }
        }
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

  let res: ImportVaultResult | null = null;
  try {
    res = await importVault({ vaultDir, dryRun });
  } finally {
    if (!dryRun) {
      await closeDb();
    }
  }

  if (res && res.failed > 0) {
    process.exit(1);
  }
}
