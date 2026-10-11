// Display guards only: never change the underlying ranking/statistics contracts.
export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function validRate(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function formatRate(value: number | null | undefined, sample?: number): string {
  if (!validRate(value) || (sample !== undefined && (!Number.isFinite(sample) || sample <= 0))) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function rateWidth(value: number | null | undefined): number {
  return validRate(value) ? value * 100 : 0;
}

/** Dates are always read in the competition's timezone, not the reader's system timezone. */
export function matchDate(value: string | null | undefined, includeTime = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "时间待确认";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  });
}
