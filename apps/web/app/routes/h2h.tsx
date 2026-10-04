import { useLoaderData, useNavigate } from "react-router";
import type { Route } from "./+types/h2h";
import type { H2HResponse, TeamsResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { IconVs } from "../components/icons";

export const handle: Screen = { name: "战队对决" };

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const teamA = url.searchParams.get("teamA") || "wolves";
  const teamB = url.searchParams.get("teamB") || "ag";

  const [h2hData, teamsData] = await Promise.all([
    loadOr404<H2HResponse>(`/api/site/kb/h2h?teamA=${teamA}&teamB=${teamB}`, { signal: request.signal }),
    loadOr404<TeamsResponse>("/api/site/kb/teams", { signal: request.signal }),
  ]);

  return { h2h: h2hData, teams: teamsData.teams, teamA, teamB };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const tA = loaderData?.h2h?.teamA.name ?? "战队A";
  const tB = loaderData?.h2h?.teamB.name ?? "战队B";
  return pageMeta({
    title: `${tA} vs ${tB}：宿命对决历史交手记录与总比分`,
    description: `${tA}与${tB}历年 KPL 历史交手总战绩、BO7 季后赛胜负、小局总得失分与胜负走势。`,
    path: "/h2h",
  });
}

export function headers() {
  return edgeTtl(60);
}

export default function H2HPage() {
  const { h2h, teams, teamA, teamB } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const handleSwitchTeams = () => {
    navigate(`/h2h?teamA=${teamB}&teamB=${teamA}`);
  };

  const handleSelectTeamA = (slug: string) => {
    if (slug === teamB) return handleSwitchTeams();
    navigate(`/h2h?teamA=${slug}&teamB=${teamB}`);
  };

  const handleSelectTeamB = (slug: string) => {
    if (slug === teamA) return handleSwitchTeams();
    navigate(`/h2h?teamA=${teamA}&teamB=${slug}`);
  };

  const { teamA: tA, teamB: tB, stats, matches } = h2h;

  const totalGames = stats.teamAGames + stats.teamBGames;
  const aGamePct = totalGames > 0 ? (stats.teamAGames / totalGames) * 100 : 50;

  const totalBo7 = stats.teamABo7Wins + stats.teamBBo7Wins;
  const aBo7Pct = totalBo7 > 0 ? (stats.teamABo7Wins / totalBo7) * 100 : 50;

  return (
    <div className="pb-14">
      <PhoneBar title="战队宿命对决" large sub={`${tA.name} vs ${tB.name}`} />

      {/* 顶部战队选择切换器 */}
      <header className="pt-3 lg:pt-1">
        <div className="rounded-card border border-line bg-surface p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-4">
            {/* 左边 Team A 选择 */}
            <div className="w-full sm:flex-1">
              <label htmlFor="team-a-select" className="block text-[11.5px] font-medium text-ink-4 mb-1">主队 (Team A)</label>
              <select
                id="team-a-select"
                aria-label="选择主队"
                value={teamA}
                onChange={(e) => handleSelectTeamA(e.target.value)}
                className="w-full h-10 rounded-lg border border-line bg-surface-2 px-3 text-[14px] font-semibold text-ink focus:border-accent focus:outline-none"
              >
                {teams.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 对调按钮 */}
            <div className="shrink-0 pt-2 sm:pt-4">
              <button
                type="button"
                onClick={handleSwitchTeams}
                title="对调两队位置"
                className="flex items-center gap-1.5 rounded-full border border-line bg-bg-sunk px-3 py-1.5 text-[12px] font-semibold text-ink-2 hover:border-accent hover:text-accent transition-colors"
              >
                <IconVs size={15} />
                <span>对调</span>
              </button>
            </div>

            {/* 右边 Team B 选择 */}
            <div className="w-full sm:flex-1">
              <label htmlFor="team-b-select" className="block text-[11.5px] font-medium text-ink-4 mb-1 sm:text-right">客队 (Team B)</label>
              <select
                id="team-b-select"
                aria-label="选择客队"
                value={teamB}
                onChange={(e) => handleSelectTeamB(e.target.value)}
                className="w-full h-10 rounded-lg border border-line bg-surface-2 px-3 text-[14px] font-semibold text-ink focus:border-accent focus:outline-none"
              >
                {teams.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </header>

      {/* 历史总战绩大比分对决卡 */}
      <section className="mt-6">
        <div className="overflow-hidden rounded-card border border-line bg-surface p-5 sm:p-7 shadow-sm">
          {/* Logo 对峙与总战绩 */}
          <div className="flex items-center justify-between gap-4">
            {/* Team A */}
            <div className="flex flex-1 flex-col items-center text-center">
              {tA.logo ? (
                <img
                  src={tA.logo}
                  alt={tA.name}
                  width={64}
                  height={64}
                  className="size-16 sm:size-20 rounded-full object-contain drop-shadow"
                />
              ) : (
                <div className="grid size-16 sm:size-20 place-items-center rounded-full bg-bg-sunk text-[20px] font-bold text-ink">
                  {tA.name.slice(0, 2)}
                </div>
              )}
              <IntentLink to={`/teams/${tA.slug}`} className="mt-2.5 text-[15px] sm:text-[18px] font-bold text-ink hover:text-accent transition-colors">
                {tA.name}
              </IntentLink>
              <div className="text-[12px] text-ink-4">{tA.city ?? "KPL 战队"}</div>
            </div>

            {/* 比分中心对撞 */}
            <div className="flex shrink-0 flex-col items-center px-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-accent">
                历史总战绩
              </div>
              <div className="mt-1 flex items-baseline gap-2 font-bold leading-none">
                <span className={`text-[36px] sm:text-[48px] num ${stats.teamAWins >= stats.teamBWins ? "text-accent" : "text-ink-3"}`}>
                  {stats.teamAWins}
                </span>
                <span className="text-[22px] sm:text-[28px] text-ink-4">:</span>
                <span className={`text-[36px] sm:text-[48px] num ${stats.teamBWins >= stats.teamAWins ? "text-accent" : "text-ink-3"}`}>
                  {stats.teamBWins}
                </span>
              </div>
              <div className="mt-1 text-[11.5px] text-ink-4">
                共交手 {stats.totalMatches} 大场
              </div>
            </div>

            {/* Team B */}
            <div className="flex flex-1 flex-col items-center text-center">
              {tB.logo ? (
                <img
                  src={tB.logo}
                  alt={tB.name}
                  width={64}
                  height={64}
                  className="size-16 sm:size-20 rounded-full object-contain drop-shadow"
                />
              ) : (
                <div className="grid size-16 sm:size-20 place-items-center rounded-full bg-bg-sunk text-[20px] font-bold text-ink">
                  {tB.name.slice(0, 2)}
                </div>
              )}
              <IntentLink to={`/teams/${tB.slug}`} className="mt-2.5 text-[15px] sm:text-[18px] font-bold text-ink hover:text-accent transition-colors">
                {tB.name}
              </IntentLink>
              <div className="text-[12px] text-ink-4">{tB.city ?? "KPL 战队"}</div>
            </div>
          </div>

          {/* 细节维度对比栏 */}
          <div className="mt-7 pt-6 border-t border-line-soft space-y-4">
            {/* 小局总胜局 */}
            <div>
              <div className="flex items-center justify-between text-[12.5px]">
                <span className="font-semibold text-ink">{stats.teamAGames} 胜局</span>
                <span className="text-ink-4">小局总得失分对比</span>
                <span className="font-semibold text-ink">{stats.teamBGames} 胜局</span>
              </div>
              <div className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-bg-sunk">
                <div className="bg-accent transition-all duration-300" style={{ width: `${aGamePct}%` }} />
                <div className="bg-ink-4 transition-all duration-300" style={{ width: `${100 - aGamePct}%` }} />
              </div>
            </div>

            {/* BO7 季后赛总胜场 */}
            <div>
              <div className="flex items-center justify-between text-[12.5px]">
                <span className="font-semibold text-ink">{stats.teamABo7Wins} 胜</span>
                <span className="text-ink-4">BO7 关键淘汰赛战绩</span>
                <span className="font-semibold text-ink">{stats.teamBBo7Wins} 胜</span>
              </div>
              <div className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-bg-sunk">
                <div className="bg-accent transition-all duration-300" style={{ width: `${aBo7Pct}%` }} />
                <div className="bg-ink-4 transition-all duration-300" style={{ width: `${100 - aBo7Pct}%` }} />
              </div>
            </div>

            {/* 最近 5 场胜负走势 */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-2">
              <span className="text-[12px] text-ink-4">
                近 5 次交锋胜者走势（左为最近）：
              </span>
              <div className="flex items-center gap-1.5">
                {stats.last5WinnerSlugs.map((slug, idx) => {
                  const isA = slug === tA.slug;
                  return (
                    <span
                      key={idx}
                      className={`inline-flex items-center justify-center rounded px-2 py-0.5 text-[11px] font-bold ${
                        isA
                          ? "bg-accent/15 text-accent border border-accent/30"
                          : "bg-bg-sunk text-ink-3 border border-line"
                      }`}
                    >
                      {isA ? tA.shortName ?? tA.name.slice(0, 2) : tB.shortName ?? tB.name.slice(0, 2)}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 历次交手完整时间轴 */}
      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-bold text-ink flex items-center gap-2">
            <span className="text-accent">
              <IconVs size={20} />
            </span>
            交手历史时间线（共 {matches.length} 场）
          </h2>
          <span className="text-[12px] text-ink-4">点击比赛卡片查看该场 20 步 BP 与战报</span>
        </div>

        {matches.length === 0 ? (
          <div className="mt-3 rounded-card border border-line bg-surface py-12 text-center text-[13.5px] text-ink-4">
            两队历史上暂无交手记录
          </div>
        ) : (
          <div className="mt-3 space-y-2.5">
            {matches.map((m) => {
              const aIsHome = m.home.slug === tA.slug;
              const aScore = aIsHome ? m.home.score : m.away.score;
              const bScore = aIsHome ? m.away.score : m.home.score;
              const aWon = m.winner === tA.slug;

              return (
                <IntentLink
                  key={m.id}
                  to={`/matches/${m.id}`}
                  className="card card-hover flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[12px] text-ink-4">
                      <span>{m.seasonName}</span>
                      {m.stage && <span>· {m.stage}</span>}
                      {m.bo && <span>· BO{m.bo}</span>}
                    </div>

                    <div className="mt-1.5 flex items-center gap-3">
                      <span className={`text-[14.5px] font-bold ${aWon ? "text-accent" : "text-ink"}`}>
                        {tA.name}
                      </span>
                      <span className="num text-[17px] font-extrabold text-ink px-1">
                        {aScore} : {bScore}
                      </span>
                      <span className={`text-[14.5px] font-bold ${!aWon && m.winner ? "text-accent" : "text-ink"}`}>
                        {tB.name}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 sm:self-center">
                    <span
                      className={`rounded px-2 py-0.5 text-[11.5px] font-bold ${
                        aWon
                          ? "bg-accent/15 text-accent"
                          : "bg-bg-sunk text-ink-4"
                      }`}
                    >
                      {aWon ? `${tA.name} 胜` : `${tB.name} 胜`}
                    </span>
                    <span className="text-[12px] text-ink-4 hidden sm:inline">查看详情 →</span>
                  </div>
                </IntentLink>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
