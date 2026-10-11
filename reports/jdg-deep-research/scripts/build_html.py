#!/usr/bin/env python3
"""Assemble self-contained offline HTML: no CDN, no fetch, no dependency install."""
import json,re,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    data=json.loads((ROOT/'processed/reader_data.json').read_text())
    # Compact JSON; escape HTML script end tags. No filesystem paths outside excerpts leaked as credentials.
    text=json.dumps(data,ensure_ascii=False,separators=(',',':')).replace('</','<\\/').replace('\u2028','\\u2028').replace('\u2029','\\u2029')
    body=(ROOT/'assets/report.html').read_text()
    for name,value in [('CSS',(ROOT/'assets/report.css').read_text()),('JS',(ROOT/'assets/report.js').read_text()),('DATA',text)]:
        assert body.count('@@'+name+'@@')==1
        body=body.replace('@@'+name+'@@',value)
    assert not re.search(r'@@[A-Z_]+@@',body)
    target=ROOT/'jdg_mid_deep_research.html';target.write_text(body)
    print(f'{target.name}: {target.stat().st_size:,} bytes, {len(data["games"])} games, {len(data["subtitles"]["evidence"])} source excerpts; SHA256 {hashlib.sha256(target.read_bytes()).hexdigest()}')
if __name__=='__main__':main()
