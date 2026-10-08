// 关注动态（P4，无账号方案）：读本浏览器的关注战队，有关注才展示横滑条，无关注不打扰。
import { useEffect, useState } from "react";
import type { FollowedResponse } from "@aihot/contracts/site";
import { useFollowTeams } from "../../lib/local-state";
import { IntentLink } from "../../components/ui/IntentLink";
import { IconArrowRight } from "../../components/icons";
import { beijingTime } from "@aihot/contracts/time";

/** 一支关注战队的最新动态：横滑卡片。 */
function TeamBlock({ slug, name, cards }: { slug: string; name: string; cards: FollowedResponse["teams"][number]["cards"] }) {
  if (cards.length === 0) return null;
  return (
    <div className="min-w-0">
      <IntentLink to={`/teams/${slug}`} className="mb-1.5 inline-flex min-h-10 items-center gap-1 text-[13px] font-semibold text-ink">
        {name} <IconArrowRight size={13} className="text-ink-4" />
      </IntentLink>
      <ul className="scrollbar-none flex snap-x snap-proximity gap-3 overflow-x-auto px-0.5 pb-2 pt-0.5">
        {cards.map((c) => (
          <li key={c.key} className="w-[240px] shrink-0 snap-start">
            <IntentLink to={`/items/${c.item.id}`} className="card card-hover flex h-full flex-col gap-2 px-3.5 py-3">
              <span className="line-clamp-2 text-[13px] font-medium leading-[1.5] text-ink">{c.item.title}</span>
              <span className="mt-auto flex items-center justify-between text-[11px] text-ink-4">
                <span className="truncate">{c.item.source.name}</span>
                <span className="num shrink-0">{c.item.publishedAt ? beijingTime(c.item.publishedAt).slice(0, 5) : ""}</span>
              </span>
            </IntentLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 首页的“关注动态”：只在浏览器有本地关注时出现。 */
export function FollowStrip() {
  const teams = useFollowTeams();
  const query = teams.join(",");
  const [data, setData] = useState<FollowedResponse | null>(null);

  useEffect(() => {
    if (!query) {
      setData(null);
      return;
    }
    let alive = true;
    fetch(`/api/site/followed?teams=${query.split(",").map(encodeURIComponent).join(",")}`)
      .then((r) => (r.ok ? (r.json() as Promise<FollowedResponse>) : null))
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [query]);

  if (!query || !data) return null;
  const blocks = data.teams.filter((t) => t.cards.length > 0);
  if (blocks.length === 0) return null;
  return (
    <section aria-label="关注动态" className="mt-6">
      <h2 className="text-[15px] font-semibold text-ink">关注动态</h2>
      <div className="mt-1 flex flex-col gap-4">
        {blocks.map((t) => (
          <TeamBlock key={t.slug} slug={t.slug} name={t.name} cards={t.cards} />
        ))}
      </div>
    </section>
  );
}
