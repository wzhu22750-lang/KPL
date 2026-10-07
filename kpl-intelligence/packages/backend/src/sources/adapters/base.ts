import type { MaterialInput, TimelineDecision } from "../../content/materials.ts";
import { decideTimeline } from "../../content/materials.ts";
import type { Candidate, SourceRow } from "../types.ts";
import type {
  AdapterCollectOptions,
  AdapterCollectResult,
  AdapterCursor,
  EntityHint,
  SourceAdapter,
} from "./types.ts";

/**
 * 基础抽象适配器，为所有平台具体适配器提供默认实现与公共模板
 */
export abstract class BaseSourceAdapter<TRaw = unknown> implements SourceAdapter<TRaw> {
  abstract readonly kind: string;

  /**
   * 默认根据 source.kind 是否匹配来判定支持
   */
  supports(source: SourceRow): boolean {
    return source.kind === this.kind;
  }

  /**
   * 抓取阶段抽象方法，由子类实现具体协议通信与数据获取
   */
  abstract collect(
    source: SourceRow,
    cursor?: AdapterCursor,
    opts?: AdapterCollectOptions,
  ): Promise<AdapterCollectResult<TRaw>>;

  /**
   * 解析阶段抽象方法，由子类实现平台专有字段映射
   */
  abstract parse(raw: TRaw, source: SourceRow): Candidate | null;

  /**
   * 标准化阶段默认实现：将通用 Candidate 包装为 MaterialInput
   */
  normalize(candidate: Candidate, raw: TRaw, source: SourceRow): MaterialInput {
    return {
      ...candidate,
      sourceId: source.id,
      via: "fetch",
      raw,
    };
  }

  /**
   * 实体抽取默认实现：
   * 若信源配置了所属战队或选手主体（owner_entity_id / owner_type），自动挂载该置信线索
   */
  extractEntities(candidate: Candidate, _raw: TRaw, source: SourceRow): EntityHint[] {
    const hints: EntityHint[] = [];
    const ownerId = (source as any).owner_entity_id || source.config?.owner_entity_id;
    const ownerType = (source as any).owner_type || source.config?.owner_type;

    if (ownerId && ownerType) {
      if (ownerType === "club") {
        hints.push({ entityType: "team", entityId: String(ownerId), confidence: 1.0 });
      } else if (ownerType === "player") {
        hints.push({ entityType: "player", entityId: String(ownerId), confidence: 1.0 });
      }
    }
    return hints;
  }

  /**
   * 时间线时间决策默认实现：
   * 采用系统通用的真实发布时间保真策略
   */
  resolveTimeline(candidate: Candidate, _raw: TRaw, _source: SourceRow): TimelineDecision | null {
    if (candidate.publishedAt && Number.isFinite(candidate.publishedAt.getTime())) {
      return decideTimeline(candidate.publishedAt, new Date());
    }
    return null;
  }
}
