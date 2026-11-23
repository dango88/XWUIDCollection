from gsuid_core.sv import Plugins

Plugins(name="XWUIDCollection", force_prefix=["ww"], allow_empty_prefix=False)

# wwtoolkit (配队工具箱) 的路由在导入时注册 —— 与 XutheringWavesUID 的
# panel_editor 同样做法：导入即挂载，不依赖 startup hook。
from .wwtoolkit import routes as _toolkit_routes  # noqa: E402
from .wwtoolkit import db as _toolkit_db  # noqa: E402

_toolkit_routes.mount()

# 存档表模型必须在 core 建表前被 import，否则 create_all 看不到它
from gsuid_core.server import on_core_start  # noqa: E402


@on_core_start
async def _wwtoolkit_init() -> None:
    await _toolkit_db.ensure_table()
