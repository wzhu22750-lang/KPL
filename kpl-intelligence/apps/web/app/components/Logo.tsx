// 康平路情报站 (KPL Intelligence) 专属品牌 Logo 与标识组件
import { SITE } from "@aihot/industry/site";

/** 康平路情报站专属 SVG 战术徽标 (Tactical Beacon & Crest) */
export function LogoMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="lmBorder" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.75" />
          <stop offset="50%" stopColor="#0e7490" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.65" />
        </linearGradient>
        <linearGradient id="lmCyan" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#67e8f9" />
          <stop offset="50%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#0891b2" />
        </linearGradient>
        <linearGradient id="lmGold" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#d97706" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#fef08a" />
        </linearGradient>
      </defs>
      {/* 战术外框底座 */}
      <rect x="1" y="1" width="30" height="30" rx="7.5" fill="#0b1419" stroke="url(#lmBorder)" strokeWidth="1.2" />
      {/* 雷达测距微环 */}
      <circle cx="16" cy="15" r="11" stroke="#22d3ee" strokeWidth="0.7" strokeDasharray="2 3" strokeOpacity="0.35" />
      {/* 左轴立柱 */}
      <path d="M8.5 9 L12 6.5 V21.5 L8.5 24 Z" fill="url(#lmCyan)" />
      <path d="M11 7 L12 6.5 V21.5 L11 22 Z" fill="#ffffff" fillOpacity="0.6" />
      {/* 右上天线展翼 */}
      <path d="M12 13.5 L19.5 7 L22.5 8.5 L16 15 Z" fill="url(#lmCyan)" />
      {/* 右下支撑底座 */}
      <path d="M14.5 13.5 L22 21.5 L19.5 23.5 L12 16 Z" fill="#155e75" />
      <path d="M12 21.5 H23 L21 23.5 H8.5 Z" fill="url(#lmCyan)" opacity="0.9" />
      {/* 荣耀金切面 */}
      <polygon points="15,12 18.5,9 17,14" fill="url(#lmGold)" />
      {/* 右上情报脉冲弧 */}
      <path d="M20 9.5 A 8 8 0 0 1 24.5 14" stroke="#22d3ee" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.75" />
      {/* 核心信标星核 */}
      <path d="M16.5 11 Q16.5 13 18.5 13 Q16.5 13 16.5 15 Q16.5 13 14.5 13 Q16.5 13 16.5 11 Z" fill="url(#lmGold)" />
      <circle cx="16.5" cy="13" r="1" fill="#ffffff" />
    </svg>
  );
}

export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  const iconSize = Math.max(16, Math.round(size * 1.08));
  return (
    <span className={`inline-flex items-center font-black leading-none tracking-[-0.03em] ${className}`} style={{ fontSize: size }} aria-label={SITE.name} role="img">
      <LogoMark size={iconSize} className="mr-[0.35em] shrink-0 drop-shadow-sm" />
      <span aria-hidden="true" className="tracking-tight">{SITE.name}</span>
    </span>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}

