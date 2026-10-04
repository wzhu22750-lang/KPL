"""让 pytest 无论从哪个入口运行，都能导入根目录的三个脚本模块。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
