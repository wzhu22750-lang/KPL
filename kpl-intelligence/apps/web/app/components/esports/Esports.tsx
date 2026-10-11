import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigation } from "react-router";
import type { MatchSummary } from "@aihot/contracts/kpl";
import { IntentLink } from "../ui/IntentLink";
import { formatNumber, formatRate, matchDate, rateWidth, validRate } from "../../lib/esports";

const MODULE_LINKS = [
  ["/heroes", "英雄榜"], ["/standings", "积分榜"], ["/teams", "战队"],
  ["/matches", "赛程赛果"], ["/h2h", "历史交手"],
] as const;

/** Connect existing routes, rather than introducing a parallel site navigation or center route. */
export function EsportsNav() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  return <nav className="esports-nav" aria-label="赛事数据导航" aria-busy={navigation.state !== "idle"}>
    {MODULE_LINKS.map(([to, label]) => {
      const active = pathname === to || pathname.startsWith(`${to}/`) || (to === "/teams" && pathname.startsWith("/players/"));
      return <IntentLink key={to} to={to} aria-current={active ? "page" : undefined}>{label}</IntentLink>;
    })}
  </nav>;
}

export function PageHeader({ title, description, kicker, children }: { title: string; description?: string; kicker?: string; children?: ReactNode }) {
  return <header className="esports-heading">
    <div className="esports-heading-copy">
      {kicker && <p className="esports-kicker">{kicker}</p>}
      <h1 data-page-title="">{title}</h1>
      {description && <p className="esports-description">{description}</p>}
    </div>
    {children && <div className="esports-heading-actions">{children}</div>}
  </header>;
}

export function Portrait({ src, name, size = 64, kind = "hero", eager = false }: { src?: string | null; name: string; size?: number; kind?: "hero" | "team" | "player"; eager?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);
  // SSR images can fail before hydration attaches onError; inspect already-completed images too.
  useEffect(() => {
    if (src && image.current?.complete && image.current.naturalWidth === 0) setFailed(src);
  }, [src]);
  return <span className={`esports-portrait esports-portrait-${kind}`} style={{ "--portrait-size": `${size}px` } as CSSProperties}>
    {src && failed !== src ? <img ref={image} src={src} alt={name} width={size} height={size} loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setFailed(src)} />
      : <span className="esports-portrait-fallback" role="img" aria-label={`${name} · 暂无图片`}>{name.slice(0, 2)}</span>}
  </span>;
}

export function TierBadge({ tier }: { tier: string }) {
  const known = ["T0", "T0.5", "T1", "T2", "T3"].includes(tier);
  return <span className="esports-tier" data-tier={known ? tier : "unknown"} aria-label={`版本梯度 ${known ? tier : "暂缺"}`}>{known ? tier : "未评级"}</span>;
}

export function Metric({ label, value, note, primary = false }: { label: string; value: ReactNode; note?: ReactNode; primary?: boolean }) {
  return <div className={`esports-metric${primary ? " esports-metric-primary" : ""}`}>
    <p className="esports-metric-label">{label}</p><p className="esports-metric-value">{value ?? "—"}</p>
    {note && <p className="esports-metric-note">{note}</p>}
  </div>;
}

export function RateBar({ value, label, tone = "accent", sample }: { value: number | null | undefined; label: string; tone?: "accent" | "blue" | "red"; sample?: ReactNode }) {
  const valid = validRate(value);
  return <div className="esports-rate" data-tone={tone}>
    <div className="esports-rate-label"><span>{label}</span><strong>{formatRate(value)}</strong></div>
    <div className="esports-rate-track" role={valid ? "meter" : undefined} aria-label={valid ? label : undefined} aria-valuemin={valid ? 0 : undefined} aria-valuemax={valid ? 100 : undefined} aria-valuenow={valid ? rateWidth(value) : undefined} aria-valuetext={valid ? formatRate(value) : undefined}>
      <span style={{ width: `${rateWidth(value)}%` }} />
    </div>
    <div className="esports-rate-scale"><span>0%</span>{sample && <span>{sample}</span>}<span>100%</span></div>
  </div>;
}

const MATCH_STATUS: Record<string, string> = { scheduled: "未开始", live: "进行中", finished: "已结束", cancelled: "已取消", postponed: "已延期" };
export function MatchRow({ match }: { match: MatchSummary }) {
  const scored = match.status === "finished" || match.status === "live";
  const date = match.status === "scheduled" ? match.scheduledAt : match.playedAt ?? match.scheduledAt;
  return <IntentLink to={`/matches/${match.id}`} className="esports-match-row">
    <div className="esports-match-meta">
      <span className="esports-match-status" data-status={match.status}>{MATCH_STATUS[match.status ?? ""] ?? "状态待确认"}</span>
      {date ? <time dateTime={date}>{matchDate(date, true)}</time> : <span>时间待确认</span>}
      <span>{match.bo ? `BO${match.bo}` : "赛制待确认"}{match.stage ? ` · ${match.stage}` : ""}</span>
    </div>
    <div className="esports-match-pair">
      <span className="esports-match-side"><Portrait src={match.home.logo} name={match.home.name} kind="team" size={36} /><span>{match.home.name}</span></span>
      <span className="esports-match-score">{scored ? `${formatNumber(match.home.score)} : ${formatNumber(match.away.score)}` : "VS"}</span>
      <span className="esports-match-side"><Portrait src={match.away.logo} name={match.away.name} kind="team" size={36} /><span>{match.away.name}</span></span>
    </div>
    <span className="esports-match-open">比赛档案 →</span>
  </IntentLink>;
}
