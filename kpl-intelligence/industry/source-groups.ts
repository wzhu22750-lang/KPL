// 发布者身份与文章主题是两个维度。这里的身份来自运营维护的信源资料，不能由文章关键词或模型推断。
export const SOURCE_GROUPS = [
  { key: 'official', label: '官方', owners: ['league'] },
  { key: 'club', label: '战队官方', owners: ['club'] },
  { key: 'participant', label: '选手/教练', owners: ['player', 'coach', 'staff'] },
  { key: 'caster', label: '二路/解说', owners: ['media'] },
  { key: 'media', label: '媒体/创作者', owners: ['media'] },
  { key: 'community', label: '社区/粉丝', owners: ['community'] },
] as const;

/** 仅匹配信源档案里的角色标签；不匹配文章标签、标题或账号名称。 */
export const CASTER_SOURCE_TAGS = ['二路', '解说', '主播', '评论员'] as const;
