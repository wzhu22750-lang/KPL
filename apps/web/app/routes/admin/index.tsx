import { SITE } from "@aihot/industry/site";
import { Link } from "react-router";
import type { Route } from "./+types/index";
import type { AdminFunnelDashboard } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { num } from "../../features/admin/format";
import { AdminPage, Badge, ButtonLink, Card, Dot, Stat, Time } from "../../features/admin/ui";

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<AdminFunnelDashboard>(request, "/api/admin/funnel");
}

export const meta: Route.MetaFunction = () => [{ title: `采集监控与流转漏斗 · ${SITE.name} 后台` }];

export default function AdminDashboard({ loaderData }: Route.ComponentProps) {
  const { funnel, sourcesHealth = [] } = loaderData;
  const total = Math.max(funnel.totalArticles, 1);
  const blockPct = ((funnel.blockedGarbage / total) * 100).toFixed(1);
  const discardPct = ((funnel.lowQualityDiscarded / total) * 100).toFixed(1);
  const curatedPct = ((funnel.curatedPublished / total) * 100).toFixed(1);

  const activeSources = sourcesHealth.filter((s) => s.enabled);
  const failingSources = sourcesHealth.filter((s) => s.failCount > 0);

  return (
    <AdminPage
      title="采集监控与流转漏斗"
      subtitle="全链路流转看板：清晰追踪从全网原始素材抓取、大模型预筛拦截、专业评分淘汰到最终精选发布的各阶段数据及信源健康状态。"
      actions={
        <div className="flex items-center gap-2">
          <ButtonLink to="/admin/sources">管理信源</ButtonLink>
          <ButtonLink to="/admin/content" tone="primary">内容诊断</ButtonLink>
        </div>
      }
    >
      {/* 核心漏斗指标卡片 */}
      <section className="mb-6">
        <h2 className="mb-3 text-[13px] font-semibold text-ink-3 uppercase tracking-wider">
          全链路内容流转漏斗
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
            <div className="text-[12.5px] font-medium text-ink-3">总素材抓取数</div>
            <div className="mt-1 text-[26px] font-bold text-ink">{num(funnel.totalArticles)}</div>
            <div className="mt-1 text-[11.5px] text-ink-4">全网信源原始抓取入库总量</div>
          </div>

          <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-ink-3">预筛拦截垃圾数</span>
              <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-rose-600">
                {blockPct}%
              </span>
            </div>
            <div className="mt-1 text-[26px] font-bold text-rose-600">{num(funnel.blockedGarbage)}</div>
            <div className="mt-1 text-[11.5px] text-ink-4">红包/广告/花絮/无关内容</div>
          </div>

          <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-ink-3">评分淘汰低质数</span>
              <span className="rounded bg-amber/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber">
                {discardPct}%
              </span>
            </div>
            <div className="mt-1 text-[26px] font-bold text-amber">{num(funnel.lowQualityDiscarded)}</div>
            <div className="mt-1 text-[11.5px] text-ink-4">未达对应信源门槛（低分）</div>
          </div>

          <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-ink-3">最终精选上架数</span>
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-600">
                {curatedPct}%
              </span>
            </div>
            <div className="mt-1 text-[26px] font-bold text-emerald-600">{num(funnel.curatedPublished)}</div>
            <div className="mt-1 text-[11.5px] text-ink-4">硬核赛果/转会/深度复盘</div>
          </div>
        </div>

        {/* 漏斗可视化渐进进度条 */}
        <div className="mt-3 rounded-card border border-line bg-surface p-4">
          <div className="flex items-center justify-between text-[12px] text-ink-3 mb-2 font-medium">
            <span>流转阶段占比分布</span>
            <span>入选精选率：<strong className="text-emerald-600 font-bold">{curatedPct}%</strong></span>
          </div>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-bg-sunk">
            <div
              className="bg-emerald-500 transition-all duration-500"
              style={{ width: `${Math.max(Number(curatedPct), 2)}%` }}
              title={`最终精选上架: ${funnel.curatedPublished}`}
            />
            <div
              className="bg-amber transition-all duration-500"
              style={{ width: `${Math.max(Number(discardPct), 2)}%` }}
              title={`评分淘汰低质: ${funnel.lowQualityDiscarded}`}
            />
            <div
              className="bg-rose-500 transition-all duration-500"
              style={{ width: `${Math.max(Number(blockPct), 2)}%` }}
              title={`预筛拦截垃圾: ${funnel.blockedGarbage}`}
            />
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-4 text-[11.5px] text-ink-3">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-emerald-500" />
              精选上架 ({funnel.curatedPublished})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-amber" />
              评分淘汰 ({funnel.lowQualityDiscarded})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-rose-500" />
              预筛拦截 ({funnel.blockedGarbage})
            </span>
          </div>
        </div>
      </section>

      {/* 信源健康状态与增量监控表格 */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-[13px] font-semibold text-ink-3 uppercase tracking-wider">
              信源健康状态与抓取监控
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-4">
              共 {sourcesHealth.length} 个信源（启用 {activeSources.length} 个 · 异常 {failingSources.length} 个）
            </p>
          </div>
          <Link
            to="/admin/sources"
            className="text-[12px] font-medium text-accent hover:underline"
          >
            配置信源 ›
          </Link>
        </div>

        <Card pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-bg-sunk/40 text-[12px] font-medium text-ink-4">
                <tr>
                  <th className="px-4 py-2.5">信源名称</th>
                  <th className="px-3 py-2.5">分级</th>
                  <th className="px-3 py-2.5">状态</th>
                  <th className="px-3 py-2.5">抓取周期</th>
                  <th className="px-3 py-2.5">最近抓取</th>
                  <th className="px-3 py-2.5 text-right">24h 增量</th>
                  <th className="px-3 py-2.5 text-right">累计素材</th>
                  <th className="px-4 py-2.5 text-right">连续失败</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {sourcesHealth.map((s) => {
                  const isHealthy = s.enabled && s.failCount === 0;
                  const isDegraded = s.enabled && s.failCount > 0 && s.failCount < 5;
                  const isFailing = s.enabled && s.failCount >= 5;

                  return (
                    <tr key={s.id} className="transition-colors hover:bg-bg-sunk/30">
                      <td className="px-4 py-3">
                        <Link
                          to={`/admin/sources/${encodeURIComponent(s.id)}`}
                          className="font-medium text-ink hover:text-accent"
                        >
                          {s.name}
                        </Link>
                        {s.lastError && (
                          <div className="mt-0.5 truncate text-[11px] text-rose-500 max-w-[260px]" title={s.lastError}>
                            {s.lastError}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-[12px]">
                        <span className="rounded bg-bg-sunk px-1.5 py-0.5 font-mono text-[11px] text-ink-3">
                          {s.tier}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-[12px]">
                        {s.enabled ? (
                          isHealthy ? (
                            <span className="inline-flex items-center gap-1.5 text-emerald-600 font-medium">
                              <span className="size-1.5 rounded-full bg-emerald-500" />
                              正常
                            </span>
                          ) : isDegraded ? (
                            <span className="inline-flex items-center gap-1.5 text-amber font-medium">
                              <span className="size-1.5 rounded-full bg-amber" />
                              重试中
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-rose-600 font-medium">
                              <span className="size-1.5 rounded-full bg-rose-500" />
                              失败
                            </span>
                          )
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-ink-4">
                            <span className="size-1.5 rounded-full bg-ink-4/40" />
                            已暂停
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-[12px] tabular-nums text-ink-3">
                        {s.intervalMinutes} 分钟
                      </td>
                      <td className="px-3 py-3 text-[12px] text-ink-4">
                        {s.lastFetchAt ? <Time at={s.lastFetchAt} /> : "—"}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium text-ink-2">
                        {s.recentArticles > 0 ? (
                          <span className="text-emerald-600 font-semibold">+{s.recentArticles}</span>
                        ) : (
                          <span className="text-ink-4">0</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-ink-3">
                        {num(s.totalArticles)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {s.failCount > 0 ? (
                          <span className="font-semibold text-rose-600">{s.failCount}</span>
                        ) : (
                          <span className="text-ink-4">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </AdminPage>
  );
}
