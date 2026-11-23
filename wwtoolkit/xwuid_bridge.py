"""与 XutheringWavesUID 的桥接：资源目录、绑定查询、数据库会话。

工具箱是 XWUIDCollection 的子模块，跑在同一个 core 进程里，可以直接复用
XutheringWavesUID 的资源目录与数据库 —— 不再自己维护一份 JSON 存档。

所有跨插件 import 都放在函数内做延迟导入：XWUIDCollection 可能先于
XutheringWavesUID 被加载，模块级 import 会在启动期炸掉。
"""

from __future__ import annotations

import sys
from pathlib import Path

_WAVES_ROOT = "plugins.XutheringWavesUID.XutheringWavesUID"


def _ensure_plugins_on_path() -> None:
    """core 启动时会把 ``plugins`` 目录挂到 sys.path；独立脚本/测试里没有，
    这里补一次，让延迟导入在两种场景下都能成立。"""
    if "plugins" in sys.modules:
        return
    plugins_dir = Path(__file__).resolve().parent.parent.parent  # .../gsuid_core/gsuid_core/plugins
    if plugins_dir.name == "plugins" and str(plugins_dir.parent) not in sys.path:
        sys.path.insert(0, str(plugins_dir.parent))


def _waves_module(suffix: str):
    _ensure_plugins_on_path()
    import importlib

    return importlib.import_module(f"{_WAVES_ROOT}.{suffix}")


def player_path() -> Path:
    return _waves_module("utils.resource.RESOURCE_PATH").PLAYER_PATH


def avatar_path() -> Path:
    return _waves_module("utils.resource.RESOURCE_PATH").AVATAR_PATH


async def resolve_uid(user_id: str, bot_id: str) -> str | None:
    """按 QQ 号查已绑定的鸣潮 uid；没绑定返回 None。"""
    WavesBind = _waves_module("utils.database.models").WavesBind
    uid = await WavesBind.get_uid_by_game(user_id, bot_id)
    return str(uid) if uid else None


async def cookie_of(uid: str, user_id: str, bot_id: str) -> tuple[bool, str | None]:
    """取该用户在这个 uid 上的 cookie，返回 (是否本人 ck, cookie)。"""
    waves_api = _waves_module("utils.waves_api").waves_api

    try:
        return await waves_api.get_ck_result(uid, user_id, bot_id)
    except Exception:  # 取 cookie 失败不该让整个网页不可用
        return False, None


def char_avatar_path(role_id: int) -> Path | None:
    """角色头像文件路径；不存在返回 None。"""
    for name in (f"role_head_{role_id}.png", f"role_head_{role_id}.webp"):
        path = avatar_path() / name
        if path.is_file():
            return path
    return None


def panel_dir(uid: str) -> Path:
    return player_path() / str(uid)


def id2name_path() -> Path | None:
    """角色 id→名字表（XWUID 缓存在 data/XutheringWavesUID/alias/ 下）。"""
    from gsuid_core.data_store import get_res_path

    for candidate in (
        get_res_path("XutheringWavesUID") / "alias" / "id2name.json",
        player_path().parent / "alias" / "id2name.json",
    ):
        if candidate.is_file():
            return candidate
    return None


def prefix() -> str:
    """XWUID 当前生效的命令前缀（默认 ww，用户在控制台可改）。"""
    return _waves_module("wutheringwaves_config").PREFIX


def matrix_info_dir():
    """矩阵 wiki 缓存目录（与 `ww矩阵信息` 指令读同一份）。"""
    return _waves_module("utils.resource.RESOURCE_PATH").MAP_CHALLENGE_PATH / "matrix"


def current_matrix_period() -> int:
    """当前矩阵期数（复用 XWUID 的周期计算，避免自己维护一套日期）。"""
    return _waves_module("wutheringwaves_abyss.period").get_matrix_period_number()


def monster_icon_path(monster_id: int):
    """本地怪物头像（XWUID 资源目录里已有的话直接用它，省一次网络请求）。"""
    for name in (f"monster_{monster_id}.png", f"monster_{monster_id}.webp"):
        path = _waves_module("utils.resource.RESOURCE_PATH").MONSTER_PATH / name
        if path.is_file():
            return path
    return None


def weapon_icon_path(weapon_id: int):
    """武器图标（XWUID 的 waves_weapon 资源目录）。"""
    for name in (f"weapon_{weapon_id}.png", f"weapon_{weapon_id}.webp"):
        path = _waves_module("utils.resource.RESOURCE_PATH").WEAPON_PATH / name
        if path.is_file():
            return path
    return None

def roster_avatar_path(role_id: int | str):
    """全角色立绘（role_pile，管理页选角用）。"""
    path = (
        _waves_module("utils.resource.RESOURCE_PATH").ROLE_PILE_PATH
        / f"role_pile_{role_id}.png"
    )
    return path if path.is_file() else None


ELEMENT_BY_ATTR = {1: "冷凝", 2: "热熔", 3: "导电", 4: "气动", 5: "衍射", 6: "湮灭"}


def head_avatar_path(role_id: int | str):
    """全角色方形头像（waves_avatar/role_head_<id>.png）。"""
    main = _waves_module("utils.resource.RESOURCE_PATH").MAIN_PATH
    path = main / "resource" / "waves_avatar" / f"role_head_{role_id}.png"
    return path if path.is_file() else None


def all_characters() -> list[dict]:
    """全角色表（含未拥有角色）：wiki map 静态数据拼 id/名字/属性/星级。"""
    import json as _json

    root = _waves_module("utils.resource.RESOURCE_PATH")
    char_dir = root.MAP_DETAIL_PATH / "char"
    out: list[dict] = []
    for f in sorted(char_dir.glob("*.json"), key=lambda p: p.stem):
        try:
            d = _json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        name = d.get("name")
        if not name:
            continue
        out.append(
            {
                "id": f.stem,
                "name": str(name),
                "element": ELEMENT_BY_ATTR.get(d.get("attributeId"), ""),
                "star": int(d.get("starLevel") or 0),
            }
        )
    return out


def charinfo_tex_path(name: str):
    """charinfo texture2d 静态素材（突破标记 promote_icon 等）。

    texture2d 没有 __init__.py（namespace 包，__file__ 为 None），
    改从 XWUID 包根直接拼路径。
    """
    if not name or "/" in name or ".." in name or "\\" in name:
        return None
    pkg_root = Path(_waves_module("utils.resource.RESOURCE_PATH").__file__).parent.parent.parent
    path = pkg_root / "wutheringwaves_charinfo" / "texture2d" / name
    return path if path.is_file() else None


def skill_icon_path(role_id: int | str, skill_name: str):
    """技能图标（XWUID 画练度统计/面板时下载到 RoleDetail/skill/<roleId>/）。"""
    if not skill_name or "/" in skill_name or ".." in skill_name:
        return None
    path = (
        _waves_module("utils.resource.RESOURCE_PATH").ROLE_DETAIL_SKILL_PATH
        / str(role_id)
        / f"skill_{skill_name.strip()}.png"
    )
    return path if path.is_file() else None


def modal_icon_path(branch_name: str):
    """共鸣模态图标（XWUID 刷新面板时下载到 cache/attribute_skill/）。"""
    if not branch_name or "/" in branch_name or ".." in branch_name:
        return None
    path = _waves_module("utils.resource.RESOURCE_PATH").CACHE_PATH / "attribute_skill" / f"{branch_name}.png"
    return path if path.is_file() else None
