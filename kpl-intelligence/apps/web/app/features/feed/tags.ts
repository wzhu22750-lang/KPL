import { CATEGORY_LABELS, SOURCE_GROUP_LABELS, type CategoryKey } from '@aihot/contracts/taxonomy';

const publisherLabels = new Set([...Object.values(SOURCE_GROUP_LABELS), '一手', '俱乐部官方', '二路', '解说', '主播', '媒体', '社区']);
const categoryTags: Record<CategoryKey, string> = {
  'match-result': '赛果战报', roster: '阵容转会', patch: '版本更新', league: '赛制公告', tactics: '战术复盘', opinion: '观点评论',
};

/** Card topic chips are not identity claims. Keep raw tags intact for topic archives and search. */
export function feedTopicTags(tags: readonly string[], category: CategoryKey | null): string[] {
  return [...new Set(tags.map(tag => tag.trim()).filter(tag => tag && !tag.startsWith('entity:') && !publisherLabels.has(tag)
    && (!category || (tag !== CATEGORY_LABELS[category] && tag !== categoryTags[category]))))].slice(0, 3);
}
