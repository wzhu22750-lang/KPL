// WeChat account overflow: more new posts than one check processes are kept in the source cursor and
// handled by later checks, rather than silently dropped, and their bodies are never bought twice.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { checkMpAccount } from "@aihot/backend/sources/mp";

const T = tag();
const MP = `mp-backlog-${T}`;
let bodyCalls = 0;

const posts = Array.from({ length: 10 }, (_, i) => ({
  position: i + 1,
  url: `https://mp.weixin.qq.com/s/backlog-${T}-${i}`,
  title: `公众号文章 ${i} ${T}`,
  post_time: Math.floor(Date.now() / 1000) - i * 60,
  digest: "摘要",
  sn: `sn-${T}-${i}`,
}));

const dajiala = await stub((_hit, req) => {
  if (req.url.startsWith("/fbmain/monitor/v3/post_history")) return { code: 0, data: posts, remain_money: 100 };
  bodyCalls += 1;
  return { code: 0, title: `文章 ${T}`, content: `<p>正文 ${T}</p>`, author: "作者", desc: "描述" };
});

process.env.DAJIALA_BASE_URL = dajiala.url;
process.env.DAJIALA_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'dajiala'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${MP}, '溢出测试号', 'mp_account', ${sql.json({ ghid: `gh_${T}` })}, 'T1', 'editorial', ${sql.json({})}, '2100-01-01')`;
});
after(async () => {
  await dajiala.close();
  await stopBoss();
  await closeDb();
});

test("超过每轮上限的候选取入 backlog，下轮继续，正文不重复计费", async () => {
  const cursor = async () => (await sql<{ cursor: { mpBacklog?: unknown[] } }[]>`SELECT cursor FROM sources WHERE id = ${MP}`)[0]!.cursor;

  const first = await checkMpAccount(MP, "manual");
  assert.equal(first.status, "ok");
  assert.equal(first.created, 8, "每轮最多处理 8 篇新文章");
  assert.equal((await cursor()).mpBacklog?.length, 2, "超出的候选保存到 backlog，不静默丢弃");
  assert.equal(bodyCalls, 8, "本轮只买 8 篇正文");

  const second = await checkMpAccount(MP, "manual");
  assert.equal(second.created, 2, "backlog 在下一轮继续处理");
  assert.equal((await cursor()).mpBacklog?.length, 0, "全部处理完后 backlog 清空");
  assert.equal(bodyCalls, 10, "剩余候选下轮处理，正文不重复购买");
});
