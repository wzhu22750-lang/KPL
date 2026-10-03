-- KPL 检索与问答层：新闻↔实体桥、向量块（pgvector）、问答记录与匿名限流。
-- 设计说明见 docs/KPL-Intelligence-技术方案.md §5.3。
-- chunks.embedding 固定 1024 维（默认 embedding 服务 text-embedding-v4）：
-- HNSW 索引要求定长向量，改用其他维度时需同步重建本表与索引。
-- 问答是“页面不调模型”规则的唯一例外端点（/api/site/qa/stream），全部付费调用走 receipts/budgets。

CREATE TABLE entity_mentions (
  article_id  text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('team', 'player', 'hero')),
  entity_id   text NOT NULL,                -- teams.id / players.id / heroes.id
  PRIMARY KEY (article_id, entity_type, entity_id)
);
CREATE INDEX entity_mentions_entity_idx ON entity_mentions (entity_type, entity_id);

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
  id          bigserial PRIMARY KEY,
  source_type text NOT NULL CHECK (source_type IN ('article', 'match', 'team', 'player', 'hero')),
  ref_id      text NOT NULL,                -- articles.id / matches.id / teams.id / players.id / heroes.id
  ord         int NOT NULL DEFAULT 0,       -- 同一来源内块的顺序
  title       text,
  content     text NOT NULL,
  token_count int,
  text_hash   text NOT NULL,                -- 内容变更才重算 embedding（照 embeddings.text_hash 先例）
  embedding   vector(1024),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chunks_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_ref_idx ON chunks (source_type, ref_id);

CREATE TABLE qa_queries (
  id             bigserial PRIMARY KEY,
  question       text NOT NULL,
  normalized_key text NOT NULL,             -- 归一化问题（去空白/标点），缓存键
  intent         text,                      -- match_query/player_query/team_query/compare/stats/tactics/news
  entities       jsonb,                     -- 识别并链接出的实体 [{type, id, name}]
  answer_text    text,
  citations      jsonb,                     -- [{n, source_type, ref_id, title, quote?}]
  data_cards     jsonb,                     -- 结构化数据卡片（比赛/对阵/趋势），不经模型
  model          text,
  prompt_version text,
  receipt_ids    bigint[],
  status         text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'empty', 'failed')),
  duration_ms    int,
  client_ip_hash text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qa_queries_key_idx ON qa_queries (normalized_key, created_at DESC);
CREATE INDEX qa_queries_created_idx ON qa_queries (created_at DESC);

-- 匿名限流：每 IP 每日问答次数（ip_hash = sha256(ip + SESSION_SECRET 派生盐)）。
CREATE TABLE qa_rate (
  day     date NOT NULL,
  ip_hash text NOT NULL,
  count   int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip_hash)
);
