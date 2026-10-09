// PostgreSQL reservations survive process restarts and share quota across sources/workers.
// No transaction/connection is held during I/O. A crashed request spends quota and its lease
// expires after 90s (production transports timeout within 20s). This is not a platform licence.
import { randomUUID } from 'node:crypto';
import type { Db, Sql } from '../db.ts';
import { isCommunityCollectionEnabled } from './community-comments.ts';

type Platform = 'hupu' | 'weibo' | 'bilibili';
export class CommunityRequestDenied extends Error {
  reason: 'disabled'|'busy'|'cooldown'|'budget';
  retryAt: Date|null;
  spacingOnly: boolean;
  constructor(reason: 'disabled'|'busy'|'cooldown'|'budget', retryAt: Date|null, spacingOnly=false) {
    super(`Community request deferred: ${reason}${retryAt ? ` until ${retryAt.toISOString()}` : ''}`);
    this.reason=reason;this.retryAt=retryAt;this.spacingOnly=spacingOnly;
  }
}
interface Control {
  window_started_at: Date; window_ms: number; request_limit: number; requests_reserved: number;
  min_interval_ms: number; next_allowed_at: Date; lease_until: Date|null; now:Date; failure_count:number;
}

export function createCommunityRequestController(db: Db, platform: Platform) {
  if (!['hupu','weibo','bilibili'].includes(platform)) throw new Error('Unsupported community platform');
  let lastToken: string|null = null;
  let lastFailed = false;
  let requestCount = 0;
  let denial: CommunityRequestDenied|null = null;

  async function failure(token: string, message: string) {
    await db`UPDATE community_platform_controls SET
      failure_count = least(failure_count + 1, 30),
      next_allowed_at = greatest(next_allowed_at, clock_timestamp() +
        (least(backoff_max_ms::numeric, backoff_base_ms::numeric * power(2::numeric, least(failure_count, 20)))::double precision * interval '1 millisecond')),
      lease_until = NULL, last_error = ${message.slice(0,1024)}, updated_at = clock_timestamp()
      WHERE platform = ${platform} AND last_request_id = ${token}::uuid`;
  }

  async function reserve(): Promise<string> {
    if (!isCommunityCollectionEnabled()) throw new CommunityRequestDenied('disabled',null);
    // A caller's long transaction would roll back reservations with its business write: reject it.
    if (!('begin' in db)) throw new Error('Community request control requires an independent SQL connection');
    const result = await (db as Sql).begin(async tx => {
      await tx`INSERT INTO community_platform_controls (platform) VALUES (${platform}) ON CONFLICT DO NOTHING`;
      const [row] = await tx<Control[]>`SELECT *, clock_timestamp() AS now FROM community_platform_controls
        WHERE platform=${platform} FOR UPDATE`;
      if (!row) throw new Error('Missing community platform control');
      const now = row.now.getTime();
      if (row.lease_until && row.lease_until.getTime() > now) return new CommunityRequestDenied('busy',row.lease_until);
      if (row.next_allowed_at.getTime() > now) return new CommunityRequestDenied('cooldown',row.next_allowed_at,row.failure_count===0 && row.next_allowed_at.getTime()-now<=5000);
      const expired = row.window_started_at.getTime() + row.window_ms <= now;
      if ((!expired && row.requests_reserved >= row.request_limit) || row.request_limit === 0)
        return new CommunityRequestDenied('budget',row.request_limit === 0 ? null : new Date(row.window_started_at.getTime()+row.window_ms));
      const token = randomUUID();
      await tx`UPDATE community_platform_controls SET
        window_started_at=${expired ? row.now : row.window_started_at},
        requests_reserved=${expired ? 1 : row.requests_reserved+1},
        last_request_id=${token}::uuid, lease_until=${new Date(now+90000)},
        next_allowed_at=${new Date(now+row.min_interval_ms)}, updated_at=clock_timestamp()
        WHERE platform=${platform}`;
      return token;
    });
    if (result instanceof CommunityRequestDenied) throw result;
    return result as string;
  }

  return {
    get requestCount() { return requestCount; },
    get denial() { return denial; },
    async run<T>(fetch:()=>Promise<T>): Promise<T> {
      let token:string;
      try {
        try { token=await reserve(); }
        catch(error) {
          if(!(error instanceof CommunityRequestDenied) || !error.spacingOnly || !error.retryAt) throw error;
          await new Promise(resolve=>setTimeout(resolve,Math.max(0,error.retryAt!.getTime()-Date.now())+1));
          token=await reserve(); // One bounded retry for ordinary request spacing, never backoff/budget.
        }
      } catch(error) { if(error instanceof CommunityRequestDenied) denial=error; throw error; }
      lastToken=token;
      lastFailed=false;
      // Recheck a live shutdown after reservation; the spent slot is deliberately not refunded.
      if (!isCommunityCollectionEnabled()) {
        await db`UPDATE community_platform_controls SET lease_until=NULL WHERE platform=${platform} AND last_request_id=${token}::uuid`;
        denial=new CommunityRequestDenied('disabled',null); throw denial;
      }
      requestCount++;
      try {
        const value=await fetch();
        await db`UPDATE community_platform_controls SET lease_until=NULL, updated_at=clock_timestamp()
          WHERE platform=${platform} AND last_request_id=${token}::uuid`;
        return value;
      } catch(error) {
        lastFailed=true;
        await failure(token,error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    // Parsed API denial/invalid envelopes also back off, even when HTTP was 200.
    async finish(error:string|null) {
      if(!lastToken || lastFailed || denial) return;
      if(error) await failure(lastToken,error);
      else await db`UPDATE community_platform_controls SET failure_count=0,last_error=NULL,updated_at=clock_timestamp()
        WHERE platform=${platform} AND last_request_id=${lastToken}::uuid AND lease_until IS NULL`;
    },
  };
}
