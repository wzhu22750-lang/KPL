// 新闻 ↔ 知识库实体的桥：从新闻标题与正文里抽取提到的战队、选手、英雄，写入 entity_mentions。
// 词典来自三处：industry/taxonomy 的战队身份词典（IDENTITY_LEXICON）、kb 的 players/player_aliases、
// heroes 表 + 常用简称。中文别名用子串匹配（快），拉丁别名用词边界正则（防 AG 撞上英文单词）；
// 单字昵称（如“信”“涵”）与单字英雄名（镜/澜/瑶）误报率太高，一律不进词典。
import { sql } from "../db.ts";
import { IDENTITY_LEXICON } from "@aihot/industry/taxonomy";

export interface EntityMentions {
  teams: string[];
  players: string[];
  heroes: string[];
}

interface AliasRule {
  id: string;
  alias: string;
  re: RegExp | null; // 拉丁别名用；null = 中文子串匹配
}

interface MentionDict {
  teams: AliasRule[];
  players: AliasRule[];
  heroes: AliasRule[];
}

const DICT_TTL_MS = 10 * 60 * 1000; // 别名会随采集增长，词典定期刷新
let dict: MentionDict | null = null;
let dictLoadedAt = 0;

const isLatin = (s: string) => /^[A-Za-z0-9 .\-]+$/.test(s);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 拉丁别名按词边界匹配；含点的全称（重庆狼队.Fly）其局部已在别名里，跳过；单个汉字误报太多。 */
function ruleOf(id: string, alias: string): AliasRule | null {
  const a = alias.trim();
  if (!a || a === "player" || a.includes(".")) return null;
  if (isLatin(a)) {
    if (a.length < 2) return null;
    return { id, alias: a, re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(a)}(?![A-Za-z0-9])`, "i") };
  }
  if ([...a].length < 2) return null;
  return { id, alias: a, re: null };
}

/** 高频英雄简称（官方名 → 口语叫法）。一词只指一个英雄时才收（“鲁班”有歧义，不收）。 */
const HERO_ALIASES: ReadonlyArray<readonly [string, ...string[]]> = [
  ["不知火舞", "火舞"], ["孙尚香", "大小姐"], ["公孙离", "阿离"], ["百里守约", "守约"], ["百里玄策", "玄策"],
  ["马可波罗", "马可"], ["成吉思汗", "狼狗"], ["东皇太一", "东皇"], ["太乙真人", "太乙"], ["鲁班七号", "小鲁班"],
];

async function loadDict(): Promise<MentionDict> {
  if (dict && Date.now() - dictLoadedAt < DICT_TTL_MS) return dict;
  const [teamRows, playerRows, heroRows] = await Promise.all([
    sql<{ id: string; alias: string }[]>`
      SELECT t.id, x.alias FROM teams t
      LEFT JOIN LATERAL (
        SELECT unnest(array_remove(t.history_names, NULL)) AS alias
        UNION SELECT a.alias FROM team_aliases a WHERE a.team_id = t.id
      ) x ON true
      WHERE x.alias IS NOT NULL`,
    sql<{ id: string; alias: string }[]>`
      SELECT p.id, x.alias FROM players p
      LEFT JOIN LATERAL (
        SELECT p.nickname AS alias WHERE p.nickname <> 'player'
        UNION SELECT a.alias FROM player_aliases a WHERE a.player_id = p.id
        UNION SELECT p.real_name WHERE p.real_name IS NOT NULL
      ) x ON true
      WHERE x.alias IS NOT NULL`,
    sql<{ id: string; name: string }[]>`SELECT id, name FROM heroes WHERE name IS NOT NULL AND length(name) >= 2`,
  ]);

  const dedupe = (map: Map<string, AliasRule>, id: string, alias: string) => {
    const rule = ruleOf(id, alias);
    if (rule) map.set(`${id}::${rule.re?.source ?? alias}`, rule);
  };

  const teams = new Map<string, AliasRule>();
  for (const r of teamRows) dedupe(teams, r.id, r.alias);
  const teamIds = new Set(teamRows.map((r) => r.id));
  for (const e of IDENTITY_LEXICON) {
    if (!teamIds.has(e.id)) continue; // 词典里只留 teams 表里存在的战队（“kpl”联盟不入 teams）
    // IDENTITY_LEXICON 的模式已经过边界调教（如 TES.A、狼队），直接作为规则。
    for (const re of e.patterns) teams.set(`${e.id}::${re.source}`, { id: e.id, alias: re.source, re });
  }

  const players = new Map<string, AliasRule>();
  for (const r of playerRows) dedupe(players, r.id, r.alias);

  const heroIdByName = new Map(heroRows.map((r) => [r.name, r.id]));
  const heroes = new Map<string, AliasRule>();
  for (const r of heroRows) dedupe(heroes, r.id, r.name);
  for (const [name, ...aliases] of HERO_ALIASES) {
    const heroId = heroIdByName.get(name);
    if (!heroId) continue;
    for (const a of aliases) dedupe(heroes, heroId, a);
  }

  dict = { teams: [...teams.values()], players: [...players.values()], heroes: [...heroes.values()] };
  dictLoadedAt = Date.now();
  return dict;
}

function matchAll(rules: AliasRule[], text: string): string[] {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (rule.re ? rule.re.test(text) : text.includes(rule.alias)) ids.add(rule.id);
  }
  return [...ids];
}

/** 从一段新闻文本里抽取提到的实体（返回各类型的 kb 主键，已去重）。 */
export async function extractEntityMentions(text: string): Promise<EntityMentions> {
  if (!text.trim()) return { teams: [], players: [], heroes: [] };
  const d = await loadDict();
  return {
    teams: matchAll(d.teams, text),
    players: matchAll(d.players, text),
    heroes: matchAll(d.heroes, text),
  };
}

/** 抽取并写入 entity_mentions（幂等）；返回新写入的关联数。 */
export async function recordArticleEntityMentions(articleId: string, text: string): Promise<number> {
  const mentions = await extractEntityMentions(text);
  const types: string[] = [];
  const ids: string[] = [];
  for (const [type, list] of [["team", mentions.teams], ["player", mentions.players], ["hero", mentions.heroes]] as const) {
    for (const id of list) {
      types.push(type);
      ids.push(id);
    }
  }
  if (types.length === 0) return 0;
  const rows = await sql`
    INSERT INTO entity_mentions (article_id, entity_type, entity_id)
    SELECT ${articleId}, t.entity_type, t.entity_id
    FROM unnest(${types}::text[], ${ids}::text[]) AS t(entity_type, entity_id)
    ON CONFLICT (article_id, entity_type, entity_id) DO NOTHING`;
  return rows.count;
}
