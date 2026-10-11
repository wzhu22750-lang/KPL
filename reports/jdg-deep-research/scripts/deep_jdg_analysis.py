#!/usr/bin/env python3
"""Verified source-only pipeline entry; old handcrafted quotes are withdrawn.
Output: processed/verified_subtitles.json, processed/subtitle_audit.json.
No subtitle_results.json generated: old artifact is audit-only and deprecated.
"""
from verify_subtitles import main
if __name__ == '__main__':
    main()
