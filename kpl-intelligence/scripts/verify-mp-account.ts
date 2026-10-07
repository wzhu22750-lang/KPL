// 一次性工具：用 Dajiala post_history（¥0.14/次）查看某公众号最近文章标题，
// 用于验证"这个 ghid 是不是 KPL 战队官方账号"（身份证据，不是靠猜名字）。
// 用法：node --env-file=.env scripts/verify-mp-account.ts gh_xxx gh_yyy
import { closeDb } from "@aihot/backend/db";
import { mpHistory } from "@aihot/backend/providers/dajiala";

for (const ghid of process.argv.slice(2).filter((a) => !a.startsWith("-"))) {
  try {
    const res = await mpHistory(ghid, { subject: `verify:${ghid}`, window: `verify-${Date.now()}` });
    console.log(`\n== ${ghid} → nickname: ${res.nickname} (${res.posts.length} posts)`);
    for (const p of res.posts.slice(0, 5)) {
      const at = p.post_time ? new Date(p.post_time * 1000).toISOString().slice(0, 10) : "?";
      console.log(`   ${at}  ${(p.title ?? "").slice(0, 60)}`);
    }
  } catch (error) {
    console.log(`\n== ${ghid} → ERROR ${String(error).slice(0, 120)}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
await closeDb();