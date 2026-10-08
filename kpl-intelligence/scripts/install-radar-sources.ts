// Adds only the four newly probed personal accounts. Never overwrites an existing administrator source.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '@aihot/backend/config';
import { closeDb,sql } from '@aihot/backend/db';
import { collectionDefaults } from '@aihot/industry/collection';
const {values}=parseArgs({options:{apply:{type:'boolean',default:false},help:{type:'boolean',default:false}}});
if(values.help) console.log('node scripts/install-radar-sources.ts [--apply]\nDefault read-only preview. Requires explicit DATABASE_URL. Only inserts missing newly verified Gemini/李九/天云/英凯 sources. Does not overwrite existing sources or grant fulltext/official authority.');
else {
  if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL explicitly');
  const ids=['weibo-gemini','weibo-caster-lijiu','weibo-caster-tianyun','weibo-caster-yingkai'];
  const pack=JSON.parse(readFileSync(path.join(REPO_ROOT,'industry/sources.json'),'utf8'));
  try {
    const found=await sql`SELECT id FROM sources WHERE id IN ${sql(ids)}`;
    const missing=pack.sources.filter((s:{id:string})=>ids.includes(s.id)&&!found.some(row=>row.id===s.id));
    if(values.apply)await sql.begin(async db=>{
      for(const source of missing){
        const policy=collectionDefaults(source);
        await db`INSERT INTO sources(id,name,kind,config,tier,owner_type,participation_mode,interval_minutes,tags,site_fulltext,syndicate_fulltext,enabled)
          VALUES (${source.id},${source.name},${source.kind},${db.json({...source.config,collectionPolicy:{mode:policy!.mode}})},${source.tier},${source.owner_type},${source.participation_mode},
            ${policy!.intervalMinutes},${source.tags},false,false,${source.enabled}) ON CONFLICT (id) DO NOTHING`;
      }
    });
    console.log(JSON.stringify({applied:values.apply,existing:found.map(r=>r.id),missing:missing.map((s:{id:string;name:string})=>({id:s.id,name:s.name}))},null,2));
  }finally{await closeDb();}
}
