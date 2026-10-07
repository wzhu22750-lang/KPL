import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parsePublishDate,
  resolveVaultSourceId,
  validateVaultMetadata,
  importVault,
} from "../scripts/import-kpl-vault.ts";

test("parsePublishDate: 解析标准时间字符串与时区", () => {
  const d1 = parsePublishDate("2025-11-10 20:35:26");
  assert.ok(d1 instanceof Date);
  assert.equal(d1.getUTCFullYear(), 2025);
  assert.equal(d1.getUTCMonth(), 10); // 11月是 10 (0-indexed)

  const d2 = parsePublishDate("2026-04-16T17:34:00+08:00");
  assert.ok(d2 instanceof Date);
  assert.equal(d2.getUTCFullYear(), 2026);

  // 空值或无效格式必须返回 null，绝不回退为当前时间
  assert.equal(parsePublishDate(undefined), null);
  assert.equal(parsePublishDate(""), null);
  assert.equal(parsePublishDate("invalid-date-string"), null);
});

test("resolveVaultSourceId: 按目录名准确映射俱乐部与联赛官方公众号 ID", () => {
  assert.equal(resolveVaultSourceId("成都AG超玩会"), "mp-ag");
  assert.equal(resolveVaultSourceId("深圳DYG"), "mp-dyg");
  assert.equal(resolveVaultSourceId("重庆狼队"), "mp-wolves");
  assert.equal(resolveVaultSourceId("苏州KSG"), "mp-ksg");
  assert.equal(resolveVaultSourceId("南京Hero久竞"), "mp-hero");
  assert.equal(resolveVaultSourceId("广州TTG"), "mp-ttg");
  assert.equal(resolveVaultSourceId("北京WB"), "mp-wb");
  assert.equal(resolveVaultSourceId("武汉eStarPro"), "mp-estar");
  assert.equal(resolveVaultSourceId("佛山DRG"), "mp-drg");
  assert.equal(resolveVaultSourceId("KPL官方与联盟综述"), "mp-kpl-official");
  assert.equal(resolveVaultSourceId("未知目录"), "mp-kpl-official");
});

test("validateVaultMetadata: 安全防护与合法性校验", () => {
  // 合法数据
  const valid = validateVaultMetadata({
    title: "测试文章",
    author: "官方",
    publish_time: "2026-01-01 12:00:00",
    source_url: "https://mp.weixin.qq.com/s/test123456",
    markdown_file: "test.md",
  });
  assert.equal(valid.valid, true);
  assert.ok(valid.metadata);

  // 缺少 title
  const noTitle = validateVaultMetadata({
    source_url: "https://mp.weixin.qq.com/s/test",
    markdown_file: "test.md",
  });
  assert.equal(noTitle.valid, false);

  // 非法 URL
  const badUrl = validateVaultMetadata({
    title: "标题",
    source_url: "javascript:alert(1)",
    markdown_file: "test.md",
  });
  assert.equal(badUrl.valid, false);

  // 目录穿越路径
  const traversal = validateVaultMetadata({
    title: "标题",
    source_url: "https://mp.weixin.qq.com/s/test",
    markdown_file: "../../../etc/passwd",
  });
  assert.equal(traversal.valid, false);
  assert.match(traversal.error ?? "", /安全越界/);
});

test("importVault: dry-run 运行不连接写库，且真实知识库无解析错误", async () => {
  const vaultDir = path.resolve(import.meta.dirname, "../../kpl_vault");
  const res = await importVault({ vaultDir, dryRun: true });

  assert.ok(res.total >= 14, `应该扫描到至少 14 篇精选文章，当前: ${res.total}`);
  assert.equal(res.failed, 0, `dryRun 不应存在任何失败文章，错误列表: ${JSON.stringify(res.errors)}`);
  assert.equal(res.imported, res.total, "dryRun 模式下全部有效文章均应标记为拟入库");
  assert.equal(res.errors.length, 0);
});

test("importVault: 隔离测试目录中的异常元数据捕获", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kpl-vault-test-"));
  try {
    const catDir = path.join(tmpDir, "测试俱乐部");
    const artDir = path.join(catDir, "2026-01-01_异常测试");
    await fs.mkdir(artDir, { recursive: true });

    // 缺少 source_url
    await fs.writeFile(
      path.join(artDir, "metadata.json"),
      JSON.stringify({
        title: "无效文章",
        publish_time: "2026-01-01 12:00:00",
        markdown_file: "article.md",
      }),
      "utf-8"
    );
    await fs.writeFile(path.join(artDir, "article.md"), "# 正文内容", "utf-8");

    const res = await importVault({ vaultDir: tmpDir, dryRun: true });
    assert.equal(res.total, 1);
    assert.equal(res.failed, 1);
    assert.equal(res.imported, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
