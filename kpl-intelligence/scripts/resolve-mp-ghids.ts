// 一次性工具：用 Dajiala post_condition（¥0.16/次，按 nickname 查询）解析俱乐部公众号的 ghid。
// 用途：为新俱乐部建 mp_account 信源前验证账号身份（返回的 nickname/ghid 就是身份证据）。
// 用法：node --env-file=.env scripts/resolve-mp-ghids.ts "上海EDG.M" "北京JDG王者荣耀分部" ...
import { credential } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { closeDb } from "@aihot/backend/db";

const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!names.length) {
  console.log('用法: node --env-file=.env scripts/resolve-mp-ghids.ts "公众号昵称" ...');
  process.exit(1);
}
const key = credential("collectors", "DAJIALA_KEY");
if (!key) throw new Error("DAJIALA_KEY is not configured");
const base = String(credential("collectors", "DAJIALA_BASE_URL") ?? "https://www.dajiala.com").replace(/\/$/, "");

for (const name of names) {
  const res = await guardedFetch(`${base}/fbmain/monitor/v3/post_condition`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ nickname: name, key, verifycode: "" }),
    timeoutMs: 30_000,
    route: "direct",
  });
  const json = JSON.parse(res.text()) as { code?: number; msg?: string; nickname?: string; ghid?: string; data?: unknown[] };
  if (json.code !== 0) {
    console.log(`${name} => code ${json.code}: ${json.msg ?? ""}`);
  } else {
    console.log(`${name} => ghid=${json.ghid} nickname=${json.nickname} today_posts=${Array.isArray(json.data) ? json.data.length : 0}`);
  }
  await new Promise((r) => setTimeout(r, 1200));
}
await closeDb();
