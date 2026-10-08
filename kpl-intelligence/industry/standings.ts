// 分组必须绑定具体赛季和赛段；不能把某一年名单当作战队的永久组别。
// 2026 年总官方赛事公告（2026-10-01）：组外单循环 BO5，两个组独立排名。
export interface StandingsRules {
  groups: Record<string, string[]>;
  description: string;
  sourceUrl: string;
}

export function standingsRules(externalId: string, stage: string): StandingsRules | null {
  if (externalId === '20260004' && stage === '擂台赛') {
    return {
      groups: {
        大师组: ['wolves', 'ag', 'jdg', 'ttg', 'ksg', 'wb'],
        精英组: ['tes-a', 'edgm', 'lgd-nbw', 'dyg', 'rw', 'hero'],
      },
      description: 'BO5 组外单循环，两个组别独立排名；胜一场积 1 分。大师组前四、精英组第一进入淘汰赛；大师组第五至六、精英组第二至五进入突围赛；精英组第六淘汰。当前排名不代表已锁定晋级。',
      sourceUrl: 'https://news.qq.com/rain/a/20261001A0ASAJ00',
    };
  }
  return null;
}
