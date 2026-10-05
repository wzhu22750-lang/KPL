-- 新信源类型 esports_api：KPL 官方赛事数据（prod.comp.smoba.qq.com，无鉴权）与 B 站电竞接口。
-- 读取器在 packages/backend/src/sources/esports.ts，配置白名单在 sources/config-keys.ts。
-- 0001 的内联 CHECK 约束由 PostgreSQL 自动命名为 sources_kind_check。

ALTER TABLE sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check
  CHECK (kind IN ('rss', 'web_list', 'json_list', 'x_search', 'mp_account', 'external', 'esports_api'));
