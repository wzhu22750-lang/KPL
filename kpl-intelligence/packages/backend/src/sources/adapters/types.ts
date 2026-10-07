import type { MaterialInput, TimelineDecision } from "../../content/materials.ts";
import type { Candidate, SourceRow } from "../types.ts";

export type AdapterCursor = Record<string, unknown>;

export interface AdapterCollectOptions {
  force?: boolean;
  limit?: number;
}

export interface AdapterCollectResult<TRaw = unknown> {
  rawItems: TRaw[];
  nextCursor?: AdapterCursor;
  detail?: Record<string, unknown> | null;
  paidReceiptIds?: number[];
}

export interface EntityHint {
  entityType: "team" | "player" | "hero";
  entityId: string;
  confidence?: number;
  sourceText?: string;
}

/**
 * 统一社交/社区信源适配器契约 (SourceAdapter)
 * 供微博、B站、抖音、虎扑、NGA等统一接入，取代 collect.ts 中的硬编码分支。
 */
export interface SourceAdapter<TRaw = unknown> {
  /** 适配器唯一类型标识，如 "weibo", "bilibili_dynamic", "douyin", "hupu" */
  readonly kind: string;

  /** 是否承接该信源行（默认匹配 source.kind === this.kind，支持扩展条件匹配） */
  supports(source: SourceRow): boolean;

  /** 负责协议抓取、鉴权会话保活、分页游标维护 */
  collect(source: SourceRow, cursor?: AdapterCursor, opts?: AdapterCollectOptions): Promise<AdapterCollectResult<TRaw>>;

  /** 将平台原始数据解析为通用 Candidate 候选结构 */
  parse(raw: TRaw, source: SourceRow): Candidate | null;

  /** 将 Candidate 转换为落库的 MaterialInput，装载 canonical、media、social 结构 */
  normalize(candidate: Candidate, raw: TRaw, source: SourceRow): MaterialInput;

  /** 提取实体提及线索（战队/选手/英雄），供入库时建立关系索引 */
  extractEntities?(candidate: Candidate, raw: TRaw, source: SourceRow): EntityHint[];

  /** 裁定博文的真实发布时间与入库时间线时间 */
  resolveTimeline?(candidate: Candidate, raw: TRaw, source: SourceRow): TimelineDecision | null;
}
