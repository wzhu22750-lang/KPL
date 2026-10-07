import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sql } from "@aihot/backend/db";
import { importVault } from "../scripts/import-kpl-vault.ts";

test("kpl-vault-import 测试集", async (t) => {
  // 检查数据库连通性
  try {
    await sql`SELECT 1`;
  } catch (err) {
    t.skip("跳过依赖本地 PostgreSQL 的集成测试（当前未运行本地测试数据库）: " + (err as Error).message);
    return;
  }

  // 确保测试数据库存在信源与战队实体种子
  await sql`
    INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
    VALUES 
      ('mp-kpl-official', 'KPL官方', 'mp_account', 'T1', 'editorial', true, true, now()),
      ('mp-ag', '成都AG超玩会', 'mp_account', 'T1', 'editorial', true, true, now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO teams (id, name, slug, history_names)
    VALUES ('team-ag', '成都AG超玩会', 'ag', ARRAY['成都AG', 'AG超玩会'])
    ON CONFLICT (id) DO NOTHING
  `;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kpl-vault-test-"));

  // 构造两个假目录
  // 1. 成都AG超玩会目录
  const agDir = path.join(tmpDir, "成都AG超玩会", "2025-11-10_鸟巢测试");
  await fs.mkdir(agDir, { recursive: true });
  await fs.writeFile(
    path.join(agDir, "metadata.json"),
    JSON.stringify({
      title: "鸟巢总决赛测试文章成都AG超玩会",
      author: "触乐",
      publish_time: "2025-11-10 20:30:00",
      source_url: "https://mp.weixin.qq.com/s/test_ag_mock_1",
      markdown_file: "article.md",
    })
  );
  await fs.writeFile(
    path.join(agDir, "article.md"),
    "# 鸟巢总决赛测试文章\n\n成都AG超玩会在鸟巢夺得冠军，一诺与钟意发挥出色！\n"
  );

  // 2. 联盟综合目录（无明确战队）
  const leagueDir = path.join(tmpDir, "KPL官方与联盟综述", "2026-01-01_联盟公告");
  await fs.mkdir(leagueDir, { recursive: true });
  await fs.writeFile(
    path.join(leagueDir, "metadata.json"),
    JSON.stringify({
      title: "2026KPL赛事联盟发展规划白皮书",
      author: "联盟赛事组",
      publish_time: "2026-01-01 12:00:00",
      source_url: "https://mp.weixin.qq.com/s/test_league_mock_2",
      markdown_file: "article.md",
    })
  );
  await fs.writeFile(
    path.join(leagueDir, "article.md"),
    "# 2026KPL赛事联盟发展规划白皮书\n\n关于未来十年移动电竞的全面规划。\n"
  );

  await t.test("1. dry-run 模式：零写入", async () => {
    const res = await importVault({ vaultDir: tmpDir, dryRun: true });
    assert.equal(res.total, 2);
    assert.equal(res.imported, 2);

    const [found] = await sql`SELECT count(*) FROM articles WHERE url LIKE '%test_ag_mock_1%'`;
    assert.equal(Number(found.count), 0, "dry-run 不应写入数据库");
  });

  await t.test("2. 首次正常导入：imported=2 并建立实体关联", async () => {
    const res = await importVault({ vaultDir: tmpDir, dryRun: false });
    assert.equal(res.imported, 2);
    assert.equal(res.failed, 0);

    const [art] = await sql<{ id: string; title: string; published_at: Date }[]>`
      SELECT id, title, published_at FROM articles WHERE url = 'https://mp.weixin.qq.com/s/test_ag_mock_1'
    `;
    assert.ok(art, "文章应成功入库");
    assert.equal(art.title, "鸟巢总决赛测试文章成都AG超玩会");

    // 检查实体匹配
    const mentions = await sql<{ entity_id: string }[]>`
      SELECT entity_id FROM entity_mentions WHERE article_id = ${art.id}
    `;
    assert.ok(mentions.length > 0, "应命中成都AG或一诺等实体关联");
  });

  await t.test("3. 幂等性测试：再次导入正常跳过已存在内容", async () => {
    const res = await importVault({ vaultDir: tmpDir, dryRun: false });
    assert.equal(res.imported, 0, "再次导入时无新增文章");
    assert.equal(res.skipped, 2, "全部已存在且关联完整的文章应跳过");
    assert.equal(res.failed, 0);
  });

  await t.test("3.1 断点恢复测试：若关联 publications 缺失则自动补齐", async () => {
    const [art] = await sql<{ id: string }[]>`
      SELECT id FROM articles WHERE url = 'https://mp.weixin.qq.com/s/test_ag_mock_1'
    `;
    assert.ok(art);
    await sql`DELETE FROM publications WHERE article_id = ${art.id}`;

    const res = await importVault({ vaultDir: tmpDir, dryRun: false });
    assert.equal(res.imported, 1, "缺失 publication 的文章应被恢复补齐");
    assert.equal(res.skipped, 1, "另一篇完整文章应跳过");
    assert.equal(res.failed, 0);

    const [pub] = await sql<{ article_id: string }[]>`
      SELECT article_id FROM publications WHERE article_id = ${art.id}
    `;
    assert.ok(pub, "publications 应成功补齐");
  });

  await t.test("4. 容错测试：损坏的 metadata.json 不会导致整个导入流程崩溃", async () => {
    const brokenDir = path.join(tmpDir, "KPL官方与联盟综述", "2026-02-02_损坏数据");
    await fs.mkdir(brokenDir, { recursive: true });
    await fs.writeFile(path.join(brokenDir, "metadata.json"), "{ broken json");

    const res = await importVault({ vaultDir: tmpDir, dryRun: false });
    assert.equal(res.failed, 1, "应记录 1 篇失败");
    assert.equal(res.skipped, 2, "已入库且关联完整的 2 篇应正常跳过");
    assert.equal(res.imported, 0);
  });

  // 清理临时目录
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});
