-- 新信源类型 weibo：微博官方与俱乐部动态采集适配器
-- 读取器在 packages/backend/src/sources/adapters/weibo.ts，配置白名单在 sources/config-keys.ts。
-- 修改 sources.kind 检查约束，加入 'weibo'。

ALTER TABLE sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check
  CHECK (kind IN ('rss', 'web_list', 'json_list', 'x_search', 'mp_account', 'external', 'esports_api', 'weibo'));
