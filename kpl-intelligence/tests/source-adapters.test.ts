import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import type { Candidate, SourceRow } from "@aihot/backend/sources/types";
import {
  BaseSourceAdapter,
  clearAdapters,
  findAdapter,
  getAdapterByKind,
  listRegisteredAdapters,
  registerAdapter,
  unregisterAdapter,
  type AdapterCollectOptions,
  type AdapterCollectResult,
  type AdapterCursor,
} from "@aihot/backend/sources/adapters/index";

interface MockRawItem {
  id: string;
  title: string;
  text: string;
  timeStr: string;
}

class MockSocialAdapter extends BaseSourceAdapter<MockRawItem> {
  readonly kind = "mock_social";

  async collect(
    source: SourceRow,
    _cursor?: AdapterCursor,
    _opts?: AdapterCollectOptions,
  ): Promise<AdapterCollectResult<MockRawItem>> {
    return {
      rawItems: [
        {
          id: "post_1001",
          title: "战队动态：首发名单公布",
          text: "2026年总决赛首发名单：一诺、钟意出战！",
          timeStr: "2026-10-07T12:00:00Z",
        },
      ],
      nextCursor: { lastId: "post_1001" },
      detail: { fetchedCount: 1 },
    };
  }

  parse(raw: MockRawItem, _source: SourceRow): Candidate | null {
    return {
      url: `https://example.com/posts/${raw.id}`,
      title: raw.title,
      bodyText: raw.text,
      publishedAt: new Date(raw.timeStr),
    };
  }
}

const mockSource: SourceRow = {
  id: "test-social-source",
  name: "测试社交信源",
  kind: "mock_social" as any,
  config: {
    owner_entity_id: "ag",
    owner_type: "club",
  },
  tier: "T1",
  participation_mode: "editorial",
  first_party: false,
  interval_minutes: 60,
  enabled: true,
  cursor: null,
  fail_count: 0,
};

const rssSource: SourceRow = {
  id: "test-rss-source",
  name: "测试RSS信源",
  kind: "rss",
  config: {},
  tier: "T1",
  participation_mode: "editorial",
  first_party: false,
  interval_minutes: 60,
  enabled: true,
  cursor: null,
  fail_count: 0,
};

beforeEach(() => {
  clearAdapters();
});

test("Adapter Registry: 注册、查询、列表与注销生命周期", () => {
  const adapter = new MockSocialAdapter();
  assert.equal(findAdapter(mockSource), undefined, "未注册时 findAdapter 必须返回 undefined");

  registerAdapter(adapter);
  assert.equal(getAdapterByKind("mock_social"), adapter);
  assert.equal(findAdapter(mockSource), adapter, "根据 source.kind 匹配已注册的适配器");
  assert.deepEqual(listRegisteredAdapters(), ["mock_social"]);

  unregisterAdapter("mock_social");
  assert.equal(getAdapterByKind("mock_social"), undefined);
  assert.equal(findAdapter(mockSource), undefined);
});

test("Adapter Registry: 未注册的协议 (如 rss) 不被拦截", () => {
  const adapter = new MockSocialAdapter();
  registerAdapter(adapter);

  const matched = findAdapter(rssSource);
  assert.equal(matched, undefined, "RSS 信源不得被 MockSocialAdapter 拦截");
});

test("BaseSourceAdapter: collect、parse 与 normalize 标准流程", async () => {
  const adapter = new MockSocialAdapter();
  const collectRes = await adapter.collect(mockSource);

  assert.equal(collectRes.rawItems.length, 1);
  assert.deepEqual(collectRes.nextCursor, { lastId: "post_1001" });

  const raw = collectRes.rawItems[0]!;
  const candidate = adapter.parse(raw, mockSource);
  assert.ok(candidate);
  assert.equal(candidate.title, "战队动态：首发名单公布");
  assert.equal(candidate.url, "https://example.com/posts/post_1001");

  const material = adapter.normalize(candidate, raw, mockSource);
  assert.equal(material.sourceId, mockSource.id);
  assert.equal(material.via, "fetch");
  assert.deepEqual(material.raw, raw);
});

test("BaseSourceAdapter: extractEntities 实体线索感知", () => {
  const adapter = new MockSocialAdapter();
  const raw: MockRawItem = {
    id: "post_1001",
    title: "战队动态",
    text: "正文内容",
    timeStr: "2026-10-07T12:00:00Z",
  };
  const candidate = adapter.parse(raw, mockSource)!;
  const hints = adapter.extractEntities(candidate, raw, mockSource);

  assert.equal(hints.length, 1);
  assert.equal(hints[0]?.entityType, "team");
  assert.equal(hints[0]?.entityId, "ag");
  assert.equal(hints[0]?.confidence, 1.0);
});

test("BaseSourceAdapter: resolveTimeline 时间线保真决策", () => {
  const adapter = new MockSocialAdapter();
  const pastTime = new Date(Date.now() - 3600 * 1000);
  const raw: MockRawItem = {
    id: "post_1001",
    title: "战队动态",
    text: "正文内容",
    timeStr: pastTime.toISOString(),
  };
  const candidate = adapter.parse(raw, mockSource)!;
  const timeline = adapter.resolveTimeline(candidate, raw, mockSource);

  assert.ok(timeline);
  assert.ok(timeline.publishedAt);
  assert.equal(timeline.publishedAt.getTime(), pastTime.getTime());
  assert.equal(timeline.timelineAt.getTime(), pastTime.getTime());
});
