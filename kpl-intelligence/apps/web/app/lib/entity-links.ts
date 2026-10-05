// KPL 实体（战队与选手）链接解析器：卡片与详情页共用

export const TEAM_TAG_MAP: Record<string, string> = {
  "成都AG超玩会": "ag",
  "AG超玩会": "ag",
  "成都AG": "ag",
  "AG": "ag",
  "重庆狼队": "wolves",
  "狼队": "wolves",
  "武汉eStarPro": "estar",
  "eStarPro": "estar",
  "武汉eStar": "estar",
  "eStar": "estar",
  "北京WB": "wb",
  "WB": "wb",
  "苏州KSG": "ksg",
  "KSG": "ksg",
  "广州TTG": "ttg",
  "TTG": "ttg",
  "佛山DRG": "drg",
  "DRG": "drg",
  "南通Hero久竞": "hero",
  "南京Hero久竞": "hero",
  "Hero久竞": "hero",
  "Hero": "hero",
  "济南RW侠": "rw",
  "RW侠": "rw",
  "RW": "rw",
  "长沙TES.A": "tes-a",
  "TES.A": "tes-a",
  "TES": "tes-a",
  "深圳DYG": "dyg",
  "DYG": "dyg",
  "北京JDG": "jdg",
  "JDG": "jdg",
  "西安WE": "we",
  "WE": "we",
  "上海EDG.M": "edgm",
  "EDG.M": "edgm",
  "EDGM": "edgm",
  "上海RNG.M": "rngm",
  "RNG.M": "rngm",
  "RNGM": "rngm",
  "杭州LGD.NBW": "lgd-nbw",
  "LGD.NBW": "lgd-nbw",
  "LGD": "lgd-nbw",
  "桐乡情久": "qingjiu",
  "情久": "qingjiu",
  "无锡TCG": "tcg",
  "TCG": "tcg",
};

export const POPULAR_PLAYER_SLUGS: Record<string, string> = {
  "一诺": "一诺",
  "小胖": "小胖",
  "fly": "fly",
  "Fly": "fly",
  "飞牛": "fly",
  "清融": "清融",
  "花海": "花海",
  "坦然": "坦然",
  "暖阳": "暖阳",
  "妖刀": "妖刀",
  "今屿": "今屿",
  "流浪": "流浪",
  "无畏": "无畏",
  "清清": "清清",
  "九尾": "九尾",
  "风箫": "风箫",
  "梦岚": "梦岚",
  "阿改": "阿改",
  "轩染": "轩染",
  "长生": "长生",
  "大帅": "大帅",
  "归期": "归期",
  "向鱼": "向鱼",
  "钟意": "钟意",
  "子阳": "子阳",
  "cat": "cat",
  "Cat": "cat",
  "猫神": "cat",
  "久诚": "久诚",
  "诺言": "诺言",
  "梦泪": "梦泪",
};

export interface EntityLinkInfo {
  to: string;
  type: "team" | "player" | "tag";
  label: string;
}

export function resolveEntityTag(tag: string): EntityLinkInfo {
  const clean = tag.replace(/^#/, "").trim();
  const teamSlug = TEAM_TAG_MAP[clean];
  if (teamSlug) {
    return { to: `/teams/${teamSlug}`, type: "team", label: clean };
  }

  const playerSlug = POPULAR_PLAYER_SLUGS[clean] || POPULAR_PLAYER_SLUGS[clean.toLowerCase()];
  if (playerSlug) {
    return { to: `/players/${encodeURIComponent(playerSlug)}`, type: "player", label: clean };
  }

  return { to: `/all?tag=${encodeURIComponent(clean)}`, type: "tag", label: clean };
}
