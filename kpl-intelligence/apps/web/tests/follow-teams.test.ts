// P4 关注动态的本地状态：关注战队 slugs 的读写、非法值过滤、上限。
import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

let instance = 0;
async function reader(stored: unknown = null) {
  const values = new Map<string, string>();
  if (stored !== null) values.set("aihot-follow-teams", JSON.stringify(stored));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } },
  });
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?test=follow-${instance++}`);
  return { state, values };
}

test("默认无关注，非法 slug 被拒绝", async () => {
  const { state } = await reader();
  assert.deepEqual(state.getFollowTeams(), []);
  assert.equal(state.toggleFollowTeam("AG超玩会"), false);
  assert.equal(state.toggleFollowTeam("a b"), false);
  assert.equal(state.toggleFollowTeam(""), false);
  assert.deepEqual(state.getFollowTeams(), []);
});

test("关注/取关切换并持久化", async () => {
  const { state, values } = await reader();
  assert.equal(state.toggleFollowTeam("ag"), true);
  assert.equal(state.toggleFollowTeam("wolves"), true);
  assert.deepEqual(state.getFollowTeams(), ["ag", "wolves"]);
  assert.deepEqual(JSON.parse(values.get("aihot-follow-teams")!), ["ag", "wolves"]);
  assert.equal(state.toggleFollowTeam("ag"), false);
  assert.deepEqual(state.getFollowTeams(), ["wolves"]);
});

test("读取时过滤非法值、去重、上限 30", async () => {
  const dirty = ["ag", "ag", "BAD SLUG", 42, null, ...Array.from({ length: 40 }, (_, i) => `t${i}`)];
  const { state } = await reader(dirty);
  const list = state.getFollowTeams();
  assert.equal(list.length, 30);
  assert.ok(list.includes("ag"));
  assert.ok(!list.includes("BAD SLUG"));
  assert.equal(new Set(list).size, list.length);
});
