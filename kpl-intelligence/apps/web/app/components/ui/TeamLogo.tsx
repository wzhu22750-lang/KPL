import { useState } from 'react';

/** A missing or blocked remote crest never shifts the surrounding score layout. */
export function TeamLogo({ name, logo, size = 28 }: { name: string; logo: string | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-bg-sunk text-[11px] font-semibold text-ink-3" style={{ width: size, height: size }} aria-hidden="true">
    {logo && failed !== logo
      ? <img src={logo} alt="" width={size} height={size} loading="lazy" decoding="async" className="h-full w-full object-contain" onError={() => setFailed(logo)} />
      : name.slice(0, 2)}
  </span>;
}
