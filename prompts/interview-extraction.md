# P2 — 赛后采访语料提取 LLM 提示词

## 概览

本提示词用于从 KPL（王者荣耀职业联赛）的 **赛后采访字幕**（1,290 场，`contentType === 'interview'`）中提取选手第一人称心声、职业生涯故事、转会磨合感悟、队内梗文化与战术心路。

输入是逐句带时间戳的采访字幕，输出是一个高度结构化的 JSON 对象。

---

## System Prompt

```
你是一位资深王者荣耀职业电竞（KPL）人物与战队文化采编专家，擅长从选手、教练和主持人的第一人称采访对话中提炼选手画像、职业心路与赛事背景。

你的任务是从 KPL 赛后采访字幕中提取结构化的人物语料。字幕来自 B 站 AI 自动语音识别，因此：
- 选手昵称/真名可能有音近字错（如"小胖"、"一诺"、"无畏"、"清融"、"花海"、"信"、"易安"、"句号"、"菠萝"等）
- 主持人名可能音近字错（如"天云"、"英凯"、"灵儿"、"广宇"、"琪琪"、"悦悦"、"小鹿"等）
- 战队简称/外号常在对话中出现（如"甜甜糕"指广州TTG，"超玩会"指AG，"狼队"指重庆狼队等）
- 口语化黑话频出（如"吃晕碳"、"一扎五"、"热手"、"拿捏"、"互喂"等）

你需要：
1. 准确识别采访的主持人、受访选手（及所属战队）、受访教练；
2. 提取问答轮次（Q&A Rounds），精准对齐核心议题与原话回答；
3. 提取选手的标志性金句（Quote）、职业生涯转折感悟、队伍磨合经历、招牌英雄自评；
4. 提取解说/评论席在采访前后对受访选手的背景补充（如回归天数、胜负间隔、生涯里程碑）；
5. 忠实于原文，绝不凭空编造事实或添枝加叶。
```

---

## User Prompt 模板

````
请分析以下 KPL 赛后采访的字幕文本，提取结构化的人物画像与采访数据。

## 比赛信息
- 赛季：{season_name}
- 日期：{publish_date}
- 比赛：{home_team} vs {away_team}
- 视频：{title}

## 采访字幕
```
{interview_subtitles}
```

请输出以下 JSON 结构（严格遵循格式，仅输出合法 JSON，不添加外部说明）：

```json
{
  "interview_meta": {
    "host": "主持人姓名（如'天云'、'英凯'、'灵儿'等），未提及填 null",
    "interviewees": [
      {
        "name": "选手或教练昵称（如'小胖'、'无畏'）",
        "team": "所属战队（如'广州TTG'、'北京JDG'）",
        "role": "player|coach"
      }
    ],
    "segment_type": "post_match_winner|post_match_loser|desk_commentary|mixed",
    "match_result_mentioned": "采访中提及的本场赛果（如'广州TTG 3:1 佛山DRG'），未提及填 null"
  },

  "qa_dialogues": [
    {
      "round": 1,
      "topic": "transfer_feeling|match_review|team_chemistry|hero_play|funny_meme|career_milestone|future_goal",
      "question_summary": "主持人提问核心概要",
      "speaker": "回答人昵称",
      "answer_summary": "受访人回答核心观点",
      "key_quote": "受访人原话金句（逐字保留口语精华）",
      "timestamp": "该轮问答大致时间戳（如 '01:17'）"
    }
  ],

  "player_profiles": [
    {
      "player": "选手昵称",
      "team": "战队名称",
      "dimensions": {
        "personality_traits": ["性格特征标签，如'幽默搞怪'、'自信霸气'、'沉稳内敛'、'敢打敢拼'"],
        "transfer_story": "关于转会、离队、复出、加入新队伍的心路历程（无则填 null）",
        "leadership_and_voice": "在队伍中的指挥权、沟通方式或领导地位（如'负责野区进攻指挥'）",
        "hero_self_assessment": [
          {
            "hero": "英雄名",
            "comment": "选手对该英雄表现的自我评价（如'赵云混了吧，菠萝太C了'）"
          }
        ],
        "career_milestones_noted": [
          "解说或采访提及的生涯里程碑（如'时隔154天重返赛场首胜'、'久违227天后的胜利'）"
        ],
        "memes_and_culture": [
          "选手相关梗或经典发言（如'吃晕碳'、'对面野区吃饱'、'训练赛双0%胜率'）"
        ]
      }
    }
  ],

  "team_chemistry_insights": [
    {
      "team": "战队名称",
      "insight": "采访中透露的战队内部磨合、打法风格、饮食训练趣事或氛围状况",
      "timestamp": "时间戳"
    }
  ],

  "golden_quotes": [
    {
      "speaker": "发言人昵称",
      "quote": "最具有传播价值的原汁原味金句（逐字忠实记录）",
      "context": "金句语境说明（如'谈及新队伍风格磨合'）",
      "timestamp": "时间戳"
    }
  ],

  "extraction_confidence": {
    "interviewee_identified": "high|medium|low",
    "dialogue_completeness": "high|medium|low",
    "notes": "提取过程说明（如'采访后半段有评论席解说嘉宾补充点评'）"
  }
}
```

## 提取规则

### 1. 话题分类（topic）定义
- `transfer_feeling`：转会、离队、租借、加入新队或重返赛场的个人感受与适应
- `match_review`：对本场比赛对局、关键失误、翻盘点或赛前心理的复盘
- `team_chemistry`：与新队友/教练的配合、日常相处、队内分工与沟通
- `hero_play`：对于本场使用英雄的熟练度、选择原因或临场发挥自评
- `funny_meme`：搞怪、调侃、吃梗、黑话爆料
- `career_milestone`：打比赛天数、胜负纪录、冠军头衔、退役复出等生涯大事
- `future_goal`：对后续赛程、目标、冠军期望或对粉丝的发言

### 2. 人物黑话与语音修正
| 常见识别错误/简称 | 修正标准 |
|---|---|
| 甜甜糕 | 广州TTG |
| 狼队 / 胖皇 / 胖将军 | 小胖 |
| 吃晕碳 / 吃饱了 | 选手吃野区资源、进对面野区反野的幽默口头禅 |
| 菠萝 | 风箫 / 队友射手外号 |
| 诺队 / 诺宝 | 一诺 |
| 彭云飞 | Fly |
| 彭彭 | 小胖（重庆狼队时期旧称） |
| 浩浩 / 句号 | 赢徐浩 / 句号 |

### 3. 金句与原话真实性
- `key_quote` 和 `golden_quotes` 必须**一字不差地提取自字幕原话**，保留选手的语言习惯与性格色彩。
- 评论席后续的点评内容可提取进 `career_milestones_noted`，并在 `notes` 中注明来源。
````
