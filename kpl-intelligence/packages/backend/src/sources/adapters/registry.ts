import type { SourceRow } from "../types.ts";
import type { SourceAdapter } from "./types.ts";

const adapters = new Map<string, SourceAdapter<any>>();

/**
 * 注册一个适配器到全局注册中心
 */
export function registerAdapter(adapter: SourceAdapter<any>): void {
  adapters.set(adapter.kind, adapter);
}

/**
 * 注销指定适配器
 */
export function unregisterAdapter(kind: string): void {
  adapters.delete(kind);
}

/**
 * 清空所有已注册适配器（主要供测试使用）
 */
export function clearAdapters(): void {
  adapters.clear();
}

/**
 * 按 kind 直接获取适配器
 */
export function getAdapterByKind(kind: string): SourceAdapter<any> | undefined {
  return adapters.get(kind);
}

/**
 * 根据 SourceRow 查找首个能够支持的适配器
 * 优先按 source.kind 查找，其次遍历 supports 判定
 */
export function findAdapter(source: SourceRow): SourceAdapter<any> | undefined {
  const direct = adapters.get(source.kind);
  if (direct && direct.supports(source)) {
    return direct;
  }
  for (const adapter of adapters.values()) {
    if (adapter.supports(source)) {
      return adapter;
    }
  }
  return undefined;
}

/**
 * 列出当前所有已注册适配器的 kind 列表
 */
export function listRegisteredAdapters(): string[] {
  return [...adapters.keys()];
}
