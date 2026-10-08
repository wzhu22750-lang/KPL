// 康平路情报站 (KPL Intelligence) 专属品牌 Logo 与标识组件
import { SITE } from "@aihot/industry/site";

/**
 * 用户全新 KPL Intelligence 战术数据流 Logo 图标 (Mark)
 * 由白色坚毅立柱 + 蓝青发光数据流脉冲 (Data Flow Stream) + 智能指示星核组成
 */
export function LogoMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 160 160"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="kplDataFlow" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3B6DFF" />
          <stop offset="100%" stopColor="#38BDF8" />
        </linearGradient>
        <filter id="kplGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 科技深黑底座 */}
      <rect width="160" height="160" fill="#0A0E1A" rx="36" />

      {/* K 字母数据流形态 */}
      <g transform="translate(30, 20)">
        {/* 左轴垂直立柱 */}
        <rect x="15" y="30" width="14" height="80" fill="#F0F3F7" rx="2" />

        {/* 右上阶梯式数据流 */}
        <path
          d="M 29 60 L 50 45 L 56 48 L 63 43 L 70 46 L 77 40"
          stroke="url(#kplDataFlow)"
          strokeWidth="13"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          filter="url(#kplGlow)"
        />

        {/* 右下延展数据流 */}
        <path
          d="M 29 70 L 45 85 L 52 92 L 60 100 L 68 108"
          stroke="url(#kplDataFlow)"
          strokeWidth="13"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          filter="url(#kplGlow)"
        />

        {/* 右上智能指示星点 */}
        <circle cx="77" cy="40" r="7" fill="#38BDF8" opacity="0.9" />
        <circle cx="77" cy="40" r="3.5" fill="#F0F3F7" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  const iconSize = Math.max(16, Math.round(size * 1.1));
  return (
    <span className={`inline-flex items-center font-black leading-none tracking-[-0.03em] ${className}`} style={{ fontSize: size }} aria-label={SITE.name} role="img">
      <LogoMark size={iconSize} className="mr-[0.35em] shrink-0 rounded-[22%] shadow-sm" />
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


