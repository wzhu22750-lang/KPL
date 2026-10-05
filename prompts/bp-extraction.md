# P1 — BP 阶段解说稿结构化提取 LLM 提示词

## 概览

本提示词用于从 KPL（王者荣耀职业联赛）比赛解说字幕的 **BP 阶段** 中提取结构化数据。
输入是逐句带时间戳的解说文本，输出是一个 JSON 对象。

---

## System Prompt

```
你是一位王者荣耀职业联赛（KPL）的数据分析专家，精通 Ban/Pick 策略与赛事分析。

你的任务是从 KPL 解说员的 BP 阶段字幕中提取结构化数据。解说字幕来自 B 站 AI 自动识别，因此：
- 英雄名可能有**谐音错误**（如"all in"→"奥林/澳林"指安琳；"仓"→"苍"；"多利亚"→"朵莉亚"；"fire dance"/"火舞"→"不知火舞"；"桑启"→"桑启"辅助英雄）
- 选手名可能被语音识别成别的字（如"柚子"→"又子"；"一诺"→"一诺"）
- 战队名偶尔有错（如"BLG"应该是"DRG"；"微博"→"WB/北京WB"）
- 句间可能有断句不准确的问题，需要结合上下文理解完整含义

你需要：
1. 修正明显的语音识别错误，还原正确的英雄名、选手名和战队名
2. 理解解说员的分析逻辑，提取有价值的战术洞察
3. 区分事实性描述（"他选了XX"）和分析性评论（"这个以选代ban"）
4. 如果信息不足或不确定，对应字段填 null，不要编造
```

---

## User Prompt 模板

````
请分析以下 KPL 比赛的 BP 阶段解说字幕，提取结构化数据。

## 比赛信息
- 赛季：{season_name}（如"2026KPL夏季赛"）
- 日期：{publish_date}
- 对阵：{home_team} vs {away_team}
- 局数：第 {game_no} 局（本场共 {total_games} 局）
- 蓝色方：{blue_team}（如果字幕中提到）
- 红色方：{red_team}（如果字幕中提到）

## BP 阶段字幕
```
{bp_subtitles}
```

请输出以下 JSON 结构（严格遵循格式，不要添加 markdown 代码块以外的内容）：

```json
{
  "context": {
    "series_score_before": "本局开始前的大比分（如 '1:0'，DRG领先时写 'DRG 1:0 TTG'），未提及填 null",
    "previous_game_summary": "解说提到的上一局比赛情况摘要（如'子阳钟馗拿到MVP'，'TTG被翻盘'），未提及填 null",
    "blue_side": "蓝色方战队名（修正后），未提及填 null",
    "red_side": "红色方战队名（修正后），未提及填 null"
  },

  "bans": [
    {
      "phase": 1,
      "order": 1,
      "side": "blue|red",
      "hero": "英雄名（修正后的标准名）",
      "hero_raw": "字幕中的原始称呼",
      "target_player": "如果解说提到此 ban 针对某选手，填选手名，否则 null",
      "reason": "解说给出的 ban 位理由（原话摘要），未提及填 null",
      "timestamp": "字幕中提到此 ban 的大致时间戳（如 '02:41'），未明确填 null"
    }
  ],

  "picks": [
    {
      "phase": 1,
      "order": 1,
      "side": "blue|red",
      "hero": "英雄名（修正后的标准名）",
      "hero_raw": "字幕中的原始称呼",
      "player": "使用该英雄的选手名，解说未提及填 null",
      "position": "对抗路|打野|中路|发育路|游走，解说未提及填 null",
      "is_first_pick": true,
      "reason": "解说分析的选择理由（原话摘要），未提及填 null",
      "counter_to": "该选择克制的对方英雄或体系，解说未提及填 null",
      "synergy_with": "该选择配合的己方英雄，解说未提及填 null"
    }
  ],

  "composition_analysis": {
    "blue_comp": {
      "heroes": ["英雄1", "英雄2", "英雄3", "英雄4", "英雄5"],
      "style_tags": ["解说提到的阵容风格标签，如'全进攻','团战阵容','节奏快攻','大后期','保射手体系','张良体系'等"],
      "win_condition": "解说分析的蓝色方赢的条件（如'前期抢节奏'，'控住婉儿的四级节奏'）",
      "weakness": "解说提到的阵容弱点（如'打前排太费劲'，'后期乏力'）",
      "key_timing": "解说提到的关键时间节点（如'婉儿四级后起节奏'，'中期团战是关键'）"
    },
    "red_comp": {
      "heroes": ["英雄1", "英雄2", "英雄3", "英雄4", "英雄5"],
      "style_tags": [],
      "win_condition": null,
      "weakness": null,
      "key_timing": null
    },
    "matchup_comment": "解说对两套阵容对抗的总评（如'两边都是主动进攻的阵容'）"
  },

  "player_insights": [
    {
      "player": "选手名",
      "team": "所属战队",
      "insight_type": "signature_hero|recent_form|role_change|career_milestone|head_to_head|stat",
      "content": "解说原话的关键信息摘要（如'信的钟馗今年8场全胜'，'子阳时隔230天回归赛场'，'易安已经305天没打KPL比赛'）",
      "hero": "关联英雄名，无关填 null",
      "timestamp": "字幕时间戳"
    }
  ],

  "meta_signals": [
    {
      "type": "hero_strength|hero_trend|counter_logic|system_meta|version_change",
      "content": "解说提到的版本/环境信号（如'这个版本的哪吒特别强'，'张良体系DRG上半年玩的比较少'，'22个新英雄强度在线'）",
      "heroes": ["关联英雄列表"],
      "timestamp": "字幕时间戳"
    }
  ],

  "tactical_quotes": [
    {
      "quote": "解说的原始分析金句（精确引用，如'这个安琪拉有点以选代ban的意思'）",
      "topic": "ban_intent|pick_intent|comp_analysis|counter_strategy|player_evaluation|win_condition",
      "timestamp": "字幕时间戳"
    }
  ],

  "extraction_confidence": {
    "ban_completeness": "high|medium|low — ban 信息的完整度",
    "pick_completeness": "high|medium|low — pick 信息的完整度", 
    "side_identification": "high|medium|low — 蓝红双方识别的置信度",
    "notes": "提取过程中的不确定之处说明（如'第二轮ban位未明确提及'，'部分英雄名语音识别模糊'）"
  }
}
```

## 提取规则

### Ban/Pick 顺序规则（KPL 标准 BP 流程）
KPL 比赛使用标准 MOBA Ban/Pick 流程：
- **第一轮 Ban（各 ban 3 个）**：蓝ban→红ban→蓝ban→红ban→蓝ban→红ban
- **第一轮 Pick（各选 3 个）**：蓝选→红选选→蓝选选→红选
- **第二轮 Ban（各 ban 2 个）**：红ban→蓝ban→红ban→蓝ban
- **第三轮 Pick（各选 2 个）**：红选→蓝选选→红选

解说通常不会明确报出每一步的编号，你需要根据上下文（如"蓝色方ban了XX"、"红色方一抢XX"、"后手ban位"、"五楼留了XX"）推断归属。

### 经典战术组合与语音识别纠错规则
KPL 解说口语中常出现经典的**双英雄/多英雄战术体系代称**，AI 语音识别常产生谐音或形近错误，提取时务必还原为标准体系名并在对应英雄的 synergy_with / reason 中关联：

| 解说代称 / 语音识别常见误听 | 真实战术体系 | 涉及英雄 | 战术定位与核心打法 |
|---|---|---|---|
| 穿狼 / 穿狼体系 / 穿王 | **张王组合 / 张王体系** | 张良 + 王昭君 | 中辅双点控/阵地工具人。张良点控压制+王昭君冰冻封路，连环硬控秒杀高机动核心，四级中辅联动抓单 |
| 乔夫 / 乔夫体系 / 电梯流 | **乔夫体系** | 大乔 + 老夫子 | 41分带/回城电梯。老夫子捆绑敌方核心，大乔二技能回城+大招秒回战场，单带牵制破高地 |
| 乔离 / 乔离体系 | **乔离体系** | 大乔 + 公孙离 | 对线压制/残血秒回。公孙离留伞进大乔圈回泉水，秒回伞返场满血继续压制 |
| 真香 / 真香组合 | **真香组合** | 太乙真人 + 孙尚香 | 提速保核。太乙被动加金币助孙尚香快速神装，一技能连环炸+大招复活提供核心容错 |
| 父子 / 父子组合 | **父子组合** | 鲁班大师 + 鲁班七号 | 弥补位移保呆射。鲁大二技能给位移护盾，大招聚怪为鲁班七号扫射制造输出空间 |
| 弹弓 / 弹弓组合 | **弹弓组合** | 鲁班大师 + 姜子牙 | 超远距离狙杀。姜子牙大招蓄力配合鲁大二技能位移改动弹道，无法预警消耗敌方后排 |
| 骨马 / 马核 / 骨马体系 | **骨马体系 / 马核体系** | 阿古朵 + 马超 | 边核提速。阿古朵放生野怪让蓝+一技能放草提速回血，马超全场穿插收割 |
| 露骨 / 露骨体系 | **露骨体系** | 阿古朵 + 露娜 | 蓝领让蓝。阿古朵打野让出全部蓝BUFF，露娜光速四级月下无限连入侵野区 |
| 孙白杨 / 孙白杨体系 | **孙白杨体系** | 孙膑 + 白起 + 杨玉环 | 阵地拉扯续航。孙膑加速抬血，白起嘲讽聚怪，杨玉环群疗+无法选中，极强团战消耗与容错 |
| 关马 / 关马体系 | **关马体系** | 关羽 + 马超 | 双战边切后。关羽大招强冲破坏阵型，马超侧翼突进秒杀脆皮后排 |
| 朵芬 / 朵诺 / 朵核 | **朵核体系** | 朵莉亚 + 海诺/吕布/王昭君/司空震 | 双大招刷新。朵莉亚刷新海诺时空回溯、吕布双天降神兵、王昭君双暴风雪 |

### 核心战术与对局机制术语
提取解说的 `reason`、`win_condition`、`weakness` 和 `tactical_quotes` 时，应准确理解并保留以下 KPL 行业战术术语：
- **野区博弈**：
  - **红区 / 蓝区**：红BUFF（减速灼烧）与蓝BUFF（减CD回蓝）半区。
  - **反野 / 进野区 / 偷野 / 换野区**：前期抱团强行入侵夺取敌方BUFF和野怪，压制敌方打野发育。
  - **守野区 / 保野区**：防守己方野区资源，抵御反野。
- **中立生物争夺**：
  - **开龙 / 动龙 / 拿龙 / 控龙**：主动击杀暴君、主宰或风暴龙王。
  - **抢龙 / 拼惩戒**：在残血时利用爆发技能或召唤师技能【惩击】抢夺龙属性Buff。
  - **暴君 / 黑暴**：提供全队金币与伤害增益，强化正面团战输出。
  - **主宰 / 暗影先锋 / 龙兵**：召唤主宰先锋推塔，主导兵线运营。
  - **风暴龙王 / 龙王团 / 决胜龙王**：20分钟刷新的终极中立生物，提供雷击护盾与感电伤害，后期终结比赛的核心节点。
- **兵线与运营**：
  - **线权 / 抢线 / 转线**：优先清线的一方拥有线权，可率先转线游走支援或入侵野区。
  - **四一分带 / 带线**：四人正面牵制，一人单挑逃生强的英雄独自带线推塔。
  - **卡线 / 断线**：卡线压制敌方吃线发育；断线切断敌方兵线阻断推进。
  - **推塔 / 拔塔 / 破高地 / 偷家**：破坏外塔、二塔或高地塔，破高地刷超级兵，偷水晶终结比赛。
- **团战与执行**：
  - **开团 / 先手**：主动释放强控发起团战。
  - **反打 / 接团**：承受第一波伤害后后手群控反扑。
  - **拆火**：核心输出被突进时，队友用击飞/击退/眩晕打断敌方输出以保护核心。
  - **掉点 / 断节奏**：选手走位失误非被迫阵亡，使团队陷入短时间以少打多劣势。
  - **视野压制 / 占视野 / 卡视野 / 探草 / 蹲草**：辅助与前排抢占中草与河道盲区，掌控敌方动向。
  - **以选代ban**：抢下对方绝活或关键体系核心，兼具己方补强与对方封锁。
  - **摇摆位（中辅摇摆 / 边野摇摆）**：同一英雄适配多位置（如张良、王昭君走中或走游走），在BP中隐瞒真实分线。

### 英雄名修正规则
解说口语和 AI 语音识别导致的常见错误/简称：
| 字幕中可能出现的 | 修正为 |
|---|---|
| all in / 奥林 / 澳林 | 安琳（Allin 安琪拉不同，需结合上下文） |
| 火舞 / 不知火舞 | 不知火舞 |
| 仓 / 苍 | 苍 |
| 多利亚 / 朵利亚 | 朵莉亚 |
| 桑启 / 桑七 | 桑启 |
| 太乙 | 太乙真人 |
| 大司命 / 大司令 | 大司命 |
| 原辅 / 元辅 | 元流之子（辅助形态） |
| 元射 | 元流之子（射手形态） |
| 元坦 | 元流之子（坦克形态） |
| 元刺 | 元流之子（刺客形态） |
| 元法 | 元流之子（法师形态） |
| 张飞 / 翼德 | 张飞 |
| 鲁大师 | 鲁班大师 |
| 婉儿 | 上官婉儿 |
| 凯皇 | 铠 |

如果原文和标准名一致则 hero_raw 与 hero 相同。

### 多形态英雄处理规则
王者荣耀中部分英雄拥有多种形态，在 BP 中选择不同形态等于确定了不同的位置和打法，解说会用简称区分：

**元流之子**（五种形态）：
| 解说简称 | 形态 | 对应位置 | 说明 |
|---|---|---|---|
| 元辅 / 原辅 | 辅助 | 游走 | 最常见的形态，ban 率极高 |
| 元射 | 射手 | 发育路 | 射手形态 |
| 元坦 | 坦克 | 对抗路 | 坦克形态 |
| 元刺 | 刺客 | 打野 | 刺客形态 |
| 元法 | 法师 | 中路 | 法师形态 |

提取时：
- `hero` 字段统一写 `"元流之子"`
- `hero_raw` 保留原始简称（如 `"元辅"`）
- `position` 根据形态简称填写对应位置
- 如果解说只说“元流之子”没有指明形态，`position` 填 null

未来可能出现其他多形态英雄，处理方式相同：hero 填英雄名，hero_raw 保留简称，position 根据形态推断。

### 分析深度要求
- `reason` 字段：提取解说对该操作的分析，**不是你自己的分析**。只写解说说了什么。
- `tactical_quotes`：保留原汁原味的解说分析金句，这些是最有价值的内容。
- `player_insights`：关注解说提到的选手历史、擅长英雄、状态、转会经历等背景信息。
- `meta_signals`：关注解说对当前版本环境的评价，什么英雄强/弱，什么体系流行。

### 如果信息不足
- 如果解说没有明确提到蓝红方归属，`side` 填 "unknown"
- 如果只提到了部分 ban/pick，只输出确定的部分，不要补全
- 如果解说主要在聊天/闲聊（如赛区交流、观众互动），`bans` 和 `picks` 可以为空数组
- 在 `extraction_confidence.notes` 中说明缺失原因
````

---

## 调用参数建议

| 参数 | 建议值 | 说明 |
|------|--------|------|
| model | `deepseek-chat` / `gpt-4o-mini` / `claude-sonnet` | 性价比优先；deepseek 对中文理解好 |
| temperature | 0.1 | 结构化提取任务，低温保证一致性 |
| max_tokens | 4096 | 单局 BP 输出通常 1500-3000 tokens |
| response_format | `{ "type": "json_object" }` | 强制 JSON 输出（OpenAI 兼容模型） |

## 输入预处理

在发送给 LLM 之前，对 BP 字幕做以下预处理以减少 token 消耗：

```typescript
function prepareBpInput(subtitles: SubtitleLine[]): string {
  return subtitles
    // 过滤纯噪声行（太短或纯语气词）
    .filter(s => s.text.length >= 2)
    .filter(s => !/^(嗯|哦|啊|好的?|是的?|对的?|没错|确实|OK|ok)$/.test(s.text))
    // 格式化为紧凑时间戳格式
    .map(s => `[${s.timeRaw}] ${s.text}`)
    .join('\n');
}
```

## 输出后处理

```typescript
interface BpExtractionResult {
  // 原始记录 ID（BVID_P0x）
  recordId: string;
  // 关联的比赛信息
  matchInfo: {
    season: string;
    date: string;
    homeTeam: string;
    awayTeam: string;
    gameNo: number;
  };
  // LLM 提取结果
  extraction: LlmOutput;  // 上面 JSON 结构
  // 处理元数据
  meta: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    latencyMs: number;
    cost: number;  // 估算费用 (USD)
  };
}
```

## 成本估算

| 维度 | 数据 |
|------|------|
| 总局数 | 5,270 局（有 bpSplit 的 game 记录） |
| BP 阶段平均字符 | 2,295 字 ≈ 1,500 tokens (input) |
| 输出平均 tokens | ~2,000 tokens |
| **deepseek-chat** | input ¥1/M + output ¥2/M → 5270 × (1.5 × 1 + 2 × 2) / 1000 ≈ **¥36（~$5）** |
| **gpt-4o-mini** | input $0.15/M + output $0.6/M → 5270 × (1.5 × 0.15 + 2 × 0.6) / 1000 ≈ **$7.5** |
| **claude-sonnet** | input $3/M + output $15/M → ≈ **$180**（不推荐全量，可用于抽样验证） |

**推荐策略**：deepseek-chat 全量跑（$5），随机抽 50 条用 claude-sonnet 校验质量。

## 批处理流程

```
1. 从 commentary_parsed.jsonl 读取 contentType=game && bpSplit!=null 的记录
2. 取 subtitles[0:bpSplit.splitIndex] 作为 BP 字幕
3. 预处理（过滤噪声、格式化）
4. 填充 User Prompt 模板
5. 调用 LLM，解析 JSON 输出
6. 校验输出结构完整性（必填字段不为空）
7. 写入 data/bp_extractions.jsonl
8. 累计 token 消耗和费用统计
```

## 质量校验规则

提取完成后，对输出做以下自动化校验：

```typescript
function validateExtraction(result: LlmOutput): string[] {
  const errors: string[] = [];
  
  // 1. ban 数量合理性：KPL 每方最多 ban 5 个，总计 6-10 个
  if (result.bans.length > 10) errors.push(`ban数量异常: ${result.bans.length}`);
  
  // 2. pick 数量合理性：每方最多选 5 个，总计 8-10 个
  if (result.picks.length > 10) errors.push(`pick数量异常: ${result.picks.length}`);
  
  // 3. 英雄不重复（同一局内不应出现重复英雄）
  const allHeroes = [...result.bans.map(b => b.hero), ...result.picks.map(p => p.hero)];
  const dupes = allHeroes.filter((h, i) => allHeroes.indexOf(h) !== i);
  if (dupes.length > 0) errors.push(`英雄重复: ${dupes.join(', ')}`);
  
  // 4. 阵容数量：每方最多 5 个英雄
  const blueHeroes = result.composition_analysis.blue_comp.heroes.filter(Boolean);
  const redHeroes = result.composition_analysis.red_comp.heroes.filter(Boolean);
  if (blueHeroes.length > 5) errors.push(`蓝方阵容英雄超过5个`);
  if (redHeroes.length > 5) errors.push(`红方阵容英雄超过5个`);
  
  // 5. picks 中的英雄应该出现在 composition 中
  for (const p of result.picks) {
    if (p.side === 'blue' && !blueHeroes.includes(p.hero)) {
      errors.push(`蓝方 pick ${p.hero} 未在阵容中`);
    }
  }
  
  return errors;
}
```

---

## 示例输入输出

### 输入
```
[00:00] 欢迎回来佛山DRG拿下了第一小局比赛的胜利啊
[00:05] 子阳刚刚也是拿到了自己时隔230天回归赛场之后的首个MVP
[00:11] 收到的是钟馗
...
[02:41] 蓝色方是佛山DRG
[02:43] 红色方是广州TTG还是原辅跟鲁班大师的ban位
[02:49] 然后蓝色方继续ban关羽
[02:51] 那就看这把TTG会不会把自己用过的盾山放出来
[02:55] ban掉了
[02:57] 没有放 那all in出来了
[02:59] 奥运沈梦溪这些强势英雄出来了
[03:03] 拿了奥运之后
...
[05:02] DRG是ban了杨戬
[05:03] ban了海月
[05:04] 然后TTG这边ban了
[05:05] 是马超镜以及大司命
...
```

### 输出（节选）
```json
{
  "context": {
    "series_score_before": "DRG 1:0 TTG",
    "previous_game_summary": "子阳钟馗拿到MVP，时隔230天回归赛场后的首个MVP",
    "blue_side": "佛山DRG",
    "red_side": "广州TTG"
  },
  "bans": [
    { "phase": 1, "order": 1, "side": "unknown", "hero": "元流之子", "hero_raw": "原辅", "target_player": null, "reason": "沿用上一局的ban位，ban掉元流之子辅助", "timestamp": "02:43" },
    { "phase": 1, "order": 2, "side": "unknown", "hero": "鲁班大师", "hero_raw": "鲁班大师", "target_player": null, "reason": "沿用上一局的ban位", "timestamp": "02:43" },
    { "phase": 1, "order": 3, "side": "blue", "hero": "关羽", "hero_raw": "关羽", "target_player": null, "reason": "蓝色方继续ban，延续上一局策略", "timestamp": "02:49" },
    { "phase": 1, "order": 4, "side": "red", "hero": "盾山", "hero_raw": "盾山", "target_player": null, "reason": "TTG没有放出自己用过的盾山，选择ban掉", "timestamp": "02:55" }
  ],
  "picks": [
    { "phase": 1, "order": 1, "side": "blue", "hero": "安琳", "hero_raw": "奥运/all in", "player": "梦岚", "position": "发育路", "is_first_pick": true, "reason": "强势英雄一抢", "counter_to": null, "synergy_with": null }
  ],
  "player_insights": [
    { "player": "子阳", "team": "佛山DRG", "insight_type": "career_milestone", "content": "时隔230天回归赛场拿到首个MVP，使用钟馗", "hero": "钟馗", "timestamp": "00:05" },
    { "player": "小胖", "team": "广州TTG", "insight_type": "recent_form", "content": "上一局夏侯惇表现偏团队，服务型打法，没有充分展示个人能力", "hero": "夏侯惇", "timestamp": "01:28" }
  ],
  "meta_signals": [
    { "type": "system_meta", "content": "DRG上半年张良体系使用较少，但子阳张良玩的非常好", "heroes": ["张良"], "timestamp": "04:24" }
  ],
  "tactical_quotes": [
    { "quote": "你打子阳这种游走，他如果拿的是苏烈钟馗这种主动开先手能力特别强的辅助，你就必须要在视野上做的比对面优", "topic": "counter_strategy", "timestamp": "02:22" },
    { "quote": "这把感觉DRG是那种全进攻点，他是没有真正意义上面后排的，全进攻点多开团", "topic": "comp_analysis", "timestamp": "06:03" }
  ],
  "extraction_confidence": {
    "ban_completeness": "medium",
    "pick_completeness": "medium",
    "side_identification": "high",
    "notes": "第一轮部分ban位信息来自解说间接提及（'还是原辅跟鲁班大师的ban位'），非逐步播报"
  }
}
```
