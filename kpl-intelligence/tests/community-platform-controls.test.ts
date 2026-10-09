import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import postgres from 'postgres';
import { config } from '@aihot/backend/config';
import { sql, closeDb, type Sql } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { createCommunityRequestController, CommunityRequestDenied } from '@aihot/backend/content/community-platform-controls';
let enabled:boolean;
const connection = postgres(config.databaseUrl,{max:1});
before(()=>{enabled=config.collectEnabled;config.collectEnabled=true;process.env.COMMUNITY_COLLECTION_ENABLED='true';});
beforeEach(async()=>{
  process.env.COMMUNITY_COLLECTION_ENABLED='true';
  await sql`DELETE FROM community_platform_controls`;
  await sql`INSERT INTO community_platform_controls (platform,min_interval_ms,request_limit)
    VALUES ('hupu',0,2),('weibo',0,2),('bilibili',0,2)`;
});
after(async()=>{config.collectEnabled=enabled;delete process.env.COMMUNITY_COLLECTION_ENABLED;await connection.end();await stopBoss();await closeDb();});
const controller=()=>createCommunityRequestController(sql,'hupu');

test('two independent SQL clients serialize one platform without holding a connection during I/O',async()=>{
  const first=controller();
  const second=createCommunityRequestController(connection as unknown as Sql,'hupu');
  let release!:()=>void;
  let started!:()=>void;
  const seen=new Promise<void>(r=>{started=r;});
  const flight=first.run(async()=>{started();await new Promise<void>(r=>{release=r;});return 'done';});
  await seen;
  let otherCalls=0;
  try {
    await assert.rejects(second.run(async()=>{otherCalls++;}),e=>e instanceof CommunityRequestDenied && e.reason==='busy');
    const [row]=await connection`SELECT requests_reserved FROM community_platform_controls WHERE platform='hupu'`;
    assert.equal(row!.requests_reserved,1);
    assert.equal(otherCalls,0);
  } finally {release();await flight;}
});
test('window budget survives controller recreation, spans sources, and is independent across platforms',async()=>{
  await controller().run(async()=>true);
  await controller().run(async()=>true);
  const third=controller();
  await assert.rejects(third.run(async()=>assert.fail('quota denial cannot call transport')),e=>e instanceof CommunityRequestDenied && e.reason==='budget');
  assert.equal(third.requestCount,0);
  await createCommunityRequestController(sql,'weibo').run(async()=>true);
  await sql`UPDATE community_platform_controls SET window_started_at=now()-interval '2 hours' WHERE platform='hupu'`;
  await controller().run(async()=>true);
  const [row]=await sql<{requests_reserved:number}[]>`SELECT requests_reserved FROM community_platform_controls WHERE platform='hupu'`;
  assert.equal(row!.requests_reserved,1);
});
test('HTTP failure persists exponential backoff; denying retries does not spend quota or amplify failures',async()=>{
  const first=controller();
  await assert.rejects(first.run(async()=>{throw new Error('HTTP 429');}),/429/);
  await first.finish(); // never double-count one failure
  const [initial]=await sql<{failure_count:number; delay:number}[]>`SELECT failure_count,extract(epoch from (next_allowed_at-clock_timestamp())) AS delay FROM community_platform_controls WHERE platform='hupu'`;
  assert.equal(initial!.failure_count,1);assert.ok(initial!.delay>50);
  await assert.rejects(controller().run(async()=>assert.fail('backoff')),e=>e instanceof CommunityRequestDenied && e.reason==='cooldown');
  await sql`UPDATE community_platform_controls SET next_allowed_at=now() WHERE platform='hupu'`;
  await assert.rejects(controller().run(async()=>{throw new Error('HTTP 429');}),/429/);
  const [next]=await sql<{failure_count:number;requests_reserved:number;delay:number}[]>`SELECT failure_count,requests_reserved,extract(epoch from(next_allowed_at-clock_timestamp())) AS delay FROM community_platform_controls WHERE platform='hupu'`;
  assert.equal(next!.failure_count,2);assert.equal(next!.requests_reserved,2);assert.ok(next!.delay>110);
});
test('HTTP 200 invalid API envelopes back off; successful parsed recovery clears the streak',async()=>{
  const failed=controller();
  await assert.rejects(failed.run(async()=>({code:-412}),()=>{throw new Error('Bilibili API denied');}),/API denied/);
  await sql`UPDATE community_platform_controls SET next_allowed_at=now() WHERE platform='hupu'`;
  const good=controller();await good.run(async()=>({code:0}));await good.finish();
  const [row]=await sql<{failure_count:number;last_error:string|null}[]>`SELECT failure_count,last_error FROM community_platform_controls WHERE platform='hupu'`;
  assert.equal(row!.failure_count,0);assert.equal(row!.last_error,null);
});
test('expired crash lease can recover but does not refund the crashed reservation',async()=>{
  await sql`UPDATE community_platform_controls SET requests_reserved=1,lease_until=now()-interval '1 second',last_request_id='00000000-0000-0000-0000-000000000001' WHERE platform='hupu'`;
  await controller().run(async()=>true);
  await assert.rejects(controller().run(async()=>assert.fail('no refund')),e=>e instanceof CommunityRequestDenied && e.reason==='budget');
});
test('API validation owns the lease until failure is persisted; another SQL client cannot race past an HTTP 200 denial',async()=>{
  const first=controller();const second=createCommunityRequestController(connection as unknown as Sql,'hupu');
  let release!:()=>void;let started!:()=>void;
  const seen=new Promise<void>(r=>{started=r;});
  const flight=first.run(async()=>({code:-412}),async()=>{
    started();await new Promise<void>(r=>{release=r;});throw new Error('API denied after validation');
  });
  const rejection=assert.rejects(flight,/API denied after validation/);
  await seen;
  try {await assert.rejects(second.run(async()=>assert.fail('validator still holds lease')),e=>e instanceof CommunityRequestDenied && e.reason==='busy');}
  finally {release();await rejection;}
  await assert.rejects(second.run(async()=>assert.fail('persisted API backoff')),e=>e instanceof CommunityRequestDenied && e.reason==='cooldown');
  const [row]=await sql<{failure_count:number;requests_reserved:number}[]>`SELECT failure_count,requests_reserved FROM community_platform_controls WHERE platform='hupu'`;
  assert.deepEqual(row,{failure_count:1,requests_reserved:1});
});

test('migration defaults are conservative shared operational policy, not source-level overrides',async()=>{
  await sql`DELETE FROM community_platform_controls WHERE platform='hupu'`;
  await controller().run(async()=>true);
  const [row]=await sql<{window_ms:number;request_limit:number;min_interval_ms:number;requests_reserved:number}[]>`
    SELECT window_ms,request_limit,min_interval_ms,requests_reserved FROM community_platform_controls WHERE platform='hupu'`;
  assert.deepEqual(row,{window_ms:3600000,request_limit:120,min_interval_ms:1000,requests_reserved:1});
});

test('stale completion cannot clear a newer failure or lease; global shutdown forbids new requests',async()=>{
  const old=controller();await old.run(async()=>true);
  const newer=controller();await assert.rejects(newer.run(async()=>{throw new Error('HTTP 403');}),/403/);
  await old.finish();
  const [row]=await sql<{failure_count:number}[]>`SELECT failure_count FROM community_platform_controls WHERE platform='hupu'`;
  assert.equal(row!.failure_count,1);
  process.env.COMMUNITY_COLLECTION_ENABLED='false';
  await assert.rejects(controller().run(async()=>assert.fail('closed')),e=>e instanceof CommunityRequestDenied && e.reason==='disabled');
});
