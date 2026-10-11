from run_match_analysis import get_db_url, CustomEncoder
import psycopg2, psycopg2.extras, json
from pathlib import Path
c=psycopg2.connect(get_db_url());c.set_session(readonly=True,autocommit=True)
q=c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
def sql(s,args=None):
 q.execute(s,args);return [dict(x) for x in q.fetchall()]
r={}
r['columns']=sql("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")
r['game']=sql("select * from games where id='kpl-20260001-2026011401-g1'")
r['match']=sql("select * from matches where id='kpl-20260001-2026011401'")
r['bp']=sql("select * from bp_actions where game_id='kpl-20260001-2026011401-g1' order by step_index")
r['players']=sql("select * from players where id in ('昊昊','清融')")
Path('processed/db_inspection.json').write_text(json.dumps(r,ensure_ascii=False,indent=2,cls=CustomEncoder));c.close()
print('Inspection saved')
