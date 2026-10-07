-- KPL 信源体系升级：claim-type aware 权威矩阵、事件 rumor 状态机、战队官方账号档案与信源发现队列。
-- 1) sources：owner_type 标注信源主体（联盟/俱乐部/选手/教练/媒体/社区），claim_types 声明它有资格发言的
--    事实类型（空 = 全部）；tier 扩展 'T3'（选手/教练/工作人员认证账号）。
-- 2) articles：claim_type（规则分类，见 sources/claims.ts）与 origin_type（原发/转载/转引），转载与转引
--    不再算独立佐证。
-- 3) facts：事件的 claim_type 与 rumor_state（unverified → … → official_confirmed/denied）、主源与确认时间；
--    rumor_timeline 留存状态迁移（爆料 → 官宣的时间线不能被抹掉）。
-- 4) entity_accounts：联盟/战队/选手/教练 → 平台账号档案（TeamSourceProfile），verified 由人工或三重
--    证据（名称精确 + 空间页 + 近期内容）确认后置位。
-- 5) source_discovery_queue：动态战队发现（kb/discover.ts）发现新队或账号缺口时入队，后台可见，
--    不允许"悄悄没有这个战队的信息"。

-- sources.tier 扩展 T3；0001 的内联 CHECK 由 PostgreSQL 自动命名为 sources_tier_check。
ALTER TABLE sources DROP CONSTRAINT sources_tier_check;
ALTER TABLE sources ADD CONSTRAINT sources_tier_check
  CHECK (tier IN ('T1', 'T1_5', 'T2', 'T3', 'EXCLUDE_MP'));

ALTER TABLE sources ADD COLUMN owner_type text CHECK (owner_type IN ('league', 'club', 'player', 'coach', 'staff', 'media', 'community'));
ALTER TABLE sources ADD COLUMN claim_types text[] NOT NULL DEFAULT '{}';

-- 事件事实的声明类型与 rumor 状态。
ALTER TABLE facts ADD COLUMN claim_type text;
ALTER TABLE facts ADD COLUMN rumor_state text CHECK (rumor_state IN ('unverified', 'multiple_reports', 'player_hint', 'club_hint', 'official_confirmed', 'official_denied'));
ALTER TABLE facts ADD COLUMN primary_source_id text REFERENCES sources (id) ON DELETE SET NULL;
ALTER TABLE facts ADD COLUMN confirmed_at timestamptz;

CREATE TABLE rumor_timeline (
  id          bigserial PRIMARY KEY,
  fact_id     bigint NOT NULL REFERENCES facts (id) ON DELETE CASCADE,
  from_state  text,
  to_state    text NOT NULL,
  source_id   text,
  article_id  text REFERENCES articles (id) ON DELETE SET NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rumor_timeline_fact_idx ON rumor_timeline (fact_id, id);

-- 转载/转引标记：analysis 的规则层写入（sources/claims.ts），佐证独立性按 origin 归并。
ALTER TABLE articles ADD COLUMN claim_type text;
ALTER TABLE articles ADD COLUMN origin_type text CHECK (origin_type IN ('original', 'repost', 'syndication', 'quotation'));
ALTER TABLE articles ADD COLUMN origin_entity text;
CREATE INDEX articles_claim_idx ON articles (claim_type) WHERE claim_type IS NOT NULL;

-- 战队/选手官方账号档案：一个实体在一个平台的认证账号。
CREATE TABLE entity_accounts (
  id            bigserial PRIMARY KEY,
  entity_type   text NOT NULL CHECK (entity_type IN ('league', 'team', 'player', 'coach', 'staff')),
  entity_id     text NOT NULL,
  entity_name   text NOT NULL,
  platform      text NOT NULL CHECK (platform IN ('weibo', 'bilibili', 'wechat', 'douyin', 'kuaishou', 'xhs', 'website', 'x', 'camp')),
  handle        text NOT NULL,
  display_name  text,
  account_url   text,
  official_verified boolean NOT NULL DEFAULT false,
  verified_at   timestamptz,
  verified_evidence text,
  source_id     text REFERENCES sources (id) ON DELETE SET NULL,
  active        boolean NOT NULL DEFAULT true,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, platform, handle)
);
CREATE INDEX entity_accounts_entity_idx ON entity_accounts (entity_id);
CREATE INDEX entity_accounts_source_idx ON entity_accounts (source_id);

-- 信源发现队列：动态发现的新战队/缺失平台缺口，等待人工或自动验证，不静默。
CREATE TABLE source_discovery_queue (
  id          bigserial PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('league', 'team', 'player', 'coach', 'staff')),
  entity_id   text NOT NULL,
  entity_name text NOT NULL,
  platform    text NOT NULL,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'probing', 'resolved', 'unsupported')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, platform)
);
