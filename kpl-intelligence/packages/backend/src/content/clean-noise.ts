// 正文尾部广告、招聘、无关推荐与运营噪音净化工具
// 深度剔除微信文章、各大媒体稿件末尾附带的编辑署名签名档、招聘公告、
// 求报道问卷、往期推荐阅读链接、点赞在看引导、抽奖充值卡活动及关注二维码。

import * as cheerio from "cheerio";
import { collapseWhitespace } from "../lib/text.ts";

/**
 * 触发截断的尾部噪音起始标语（一旦在文章后半段出现，其后全部内容均判定为尾部噪音并整体剔除）
 */
const TAIL_CUTOFF_PATTERNS: RegExp[] = [
  /^(?:#+\s*)?(?:\*\*|__)?\s*(?:推荐阅读|往期推荐|精彩推荐|精选推荐|精彩回顾|相关阅读|延伸阅读|历史回顾|近期热点|阅读更多|更多精彩)\s*(?:\*\*|__)?(?::|：)?$/i,
  /^(?:#+\s*)?(?:\*\*|__)?\s*(?:编辑|责编|排版|校对|主编|文|策划)\s*[：:]?\s*[\p{Unified_Ideograph}\w\s·]{2,12}\s*(?:\*\*|__)?$/u,
  // 组合署名行："编辑：小K　排版：阿呜　审核：老王"（标签：任意短内容，位置+密度判定兜底）
  /^(?:\s*[|·]?\s*)?(?:编辑|责编|排版|校对|审核|主编|策划|运营|美工|文|图|摄)\s*[：:]/,
  /^(?:\*\*|__)?.*?(?:正在招聘|欢迎加入|诚聘英才|诚聘|招贤纳士).*?(?:\*\*|__)?$/i,
  /^(?:\*\*|__)?.*?(?:求报道|填写求报道问卷|商务合作|投递简历|爆料邮箱).*?(?:\*\*|__)?$/i,
  /^(?:\*\*|__)?.*?(?:觉得不错点个|关注后点|设为[⭐★]星标|点个.*?在看|点个.*?赞|长按识别二维码).*?(?:\*\*|__)?$/i,
  /^(?:\*\*|__)?.*?(?:评论区.*?(?:抽奖|抽\d位|赠送)|福利时间|steam.*?(?:充值卡|点卡)).*?(?:\*\*|__)?$/i,
  /^(?:事已至此[，,]\s*你洗碗吧|洗碗吧)/,
  /^[🎈👇👉⭐🤍❤️👍✨\s\p{Emoji}]+$/u,
];

/**
 * 针对单行/单段判定是否为无用的尾部噪音
 */
export function isNoiseBlock(text: string): boolean {
  const clean = collapseWhitespace(text).trim();
  if (!clean) return false;
  if (/^[🎈👇👉⭐🤍❤️👍✨\s\p{Emoji}]+$/u.test(clean)) return true;
  return TAIL_CUTOFF_PATTERNS.some((re) => re.test(clean));
}

/**
 * 净化纯文本 / Markdown 正文：
 * 扫描段落，一旦在文中遇到确定的尾部噪音起始标记，则切除文末所有附带噪音
 */
export function pruneTextNoise(text: string): string {
  if (!text) return "";
  const paras = text.split(/\n{2,}/);
  if (paras.length <= 1) return text;

  // 从第 2 段起寻找尾部噪音起始点（保护第 1 段为标题或导语）
  const searchStart = 1;
  let cutoffIdx = -1;

  for (let i = searchStart; i < paras.length; i++) {
    const p = paras[i]!.trim();
    const plain = p.replace(/^[#\s>*\-_`]+/, "").replace(/[*_~`]/g, "").trim();

    if (isNoiseBlock(plain) || isNoiseBlock(p)) {
      // 确认从当前段落到结尾的大多数内容符合噪点特征
      const remaining = paras.slice(i);
      const noiseCount = remaining.filter((rem) => {
        const cleanRem = rem.replace(/^[#\s>*\-_`]+/, "").replace(/[*_~`]/g, "").trim();
        return (
          isNoiseBlock(cleanRem) ||
          isNoiseBlock(rem) ||
          /^\[.*?\]\(.*?\)$/.test(rem.trim()) ||
          rem.trim().length <= 60
        );
      }).length;

      if (noiseCount >= remaining.length * 0.5) {
        cutoffIdx = i;
        break;
      }
    }
  }

  if (cutoffIdx !== -1) {
    return paras.slice(0, cutoffIdx).join("\n\n").trim();
  }

  // 若无整块截断点，逐一从末尾剥离单个噪点段落
  let end = paras.length;
  while (end > 1 && isNoiseBlock(paras[end - 1]!)) {
    end--;
  }

  return paras.slice(0, end).join("\n\n").trim();
}

const hasMedia = (el: cheerio.Cheerio<any>) =>
  el.is("img, video, picture") || el.find("img, video, picture").length > 0;

/**
 * 净化 HTML 正文：
 * 遍历 DOM 树节点，在文中定位并移除“推荐阅读”、“招聘广告”、“求报道”及其后续所有元素
 */
export function pruneHtmlNoise(html: string): string {
  if (!html || !html.trim()) return "";
  const $ = cheerio.load(html, null, false);
  const root = $.root();
  const children = root.children().toArray();
  if (children.length <= 1) return html;

  const searchStart = 1;
  let cutoffFound = false;

  for (let i = searchStart; i < children.length; i++) {
    const el = $(children[i]!);
    // 自身为图片或包含媒体图片的段落不是截断判定词
    if (hasMedia(el)) continue;
    const text = collapseWhitespace(el.text()).trim();

    if (isNoiseBlock(text)) {
      cutoffFound = true;
      for (let j = i; j < children.length; j++) {
        $(children[j]!).remove();
      }
      break;
    }
  }

  // 若未触发整段截断，从末尾逐个回溯移除纯文本噪点元素（保护图片媒体）
  if (!cutoffFound) {
    let currentChildren = root.children().toArray();
    while (currentChildren.length > 1) {
      const last = $(currentChildren[currentChildren.length - 1]!);
      if (hasMedia(last)) break;
      const text = collapseWhitespace(last.text()).trim();
      if (isNoiseBlock(text) || !text) {
        last.remove();
        currentChildren = root.children().toArray();
      } else {
        break;
      }
    }
  }

  return $.html().trim();
}
