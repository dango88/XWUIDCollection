"""XWUID 数据适配：把练度面板数据转成工具箱的角色表。

数据来源（全部来自 XutheringWavesUID 的本地落盘，不另行请求库街区）：
- ``PLAYER_PATH/<uid>/rawData.json``  —— 角色面板（等级、共鸣链、武器、声骸）
- ``PLAYER_PATH/<uid>/charListData.json`` —— 练度评分缓存 ``{roleId: score}``
- ``PLAYER_PATH/<uid>/rover.json`` —— 漂泊者（主角）各属性面板

这些文件由 XWUID 的「刷新面板」写入，因此工具箱不承担抓取与限流，
只做只读转换 —— 也顺带满足「不压测」的要求。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from gsuid_core.logger import logger

# 与 XWUID 的 resource 目录保持一致
_WAVES_PLUGIN = "plugins.XutheringWavesUID.XutheringWavesUID"
_SPECIAL_CHAR_PATH = "utils.resource.constant"

# 体力点配置：这些角色固定 2 点（与桌面版 FIXED_STAMINA2 一致）
FIXED_STAMINA2 = frozenset({"卜灵", "白芷", "守岸人", "穗穗", "莫宁", "维里奈", "莉莉"})
FIXED_STAMINA1 = frozenset({"主角"})

# 按四星处理（不显示五星金框）的五位老角色
AS_FOUR_STAR = frozenset({"卡卡罗", "凌阳", "安可", "鉴心", "维里奈"})

# 漂泊者（主角）各属性的 roleId：同一角色，切换属性共用体力。
# id2name 里每个属性有两个 id（男/女主），全部收进来。
ROVER_ROLE_IDS = frozenset({1309, 1310, 1406, 1408, 1501, 1502, 1604, 1605})


@dataclass(frozen=True)
class RosterEntry:
    """角色表里的一个人。字段与桌面版 index.html 的 character 对象对齐。"""

    id: str
    name: str
    alias: list[str]
    element: str
    quality: int
    stamina: int
    avatar: str
    level: int
    chain: int
    score: float | None
    owned: bool = True


def _player_dir(uid: str) -> Path:
    from .xwuid_bridge import panel_dir

    return panel_dir(uid)


def _read_json(path: Path) -> Any:
    """读 JSON，兼容 XWUID 的 ``.json.gz`` 压缩落盘。

    新版 XWUID 把 rawData/rover 压成 gzip（29 人 300KB → 28KB），
    老的非压缩文件仍然能读。
    """
    target = path if path.is_file() else None
    if target is None:
        gz = path.with_suffix(path.suffix + ".gz")
        if gz.is_file():
            target = gz
    if target is None:
        return None
    try:
        if target.suffix == ".gz":
            import gzip

            return json.loads(gzip.decompress(target.read_bytes()).decode("utf-8"))
        return json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning(f"[ww工具箱] 读取 {target.name} 失败：{exc}")
        return None


def _id2name() -> dict[str, str]:
    """XWUID 的角色 id→名字表，用作 roleName 的交叉校验。

    头像按 roleId 取、名字按 roleName 显示；两者若不同源，
    就会渲染出「名字是 A、头像却是 B」的错配。
    """
    from .xwuid_bridge import id2name_path

    path = id2name_path()
    if path is None:
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items()}


def _canon_name(role_id: int, raw_name: str, table: dict[str, str]) -> str:
    """以官方 id2name 为准；表里查不到才退回面板里的名字。"""
    official = table.get(str(role_id))
    if official and official != raw_name:
        logger.info(
            f"[ww工具箱] roleId={role_id} 面板名 {raw_name!r} 与官方表 {official!r} 不一致，采用官方名"
        )
    return official or raw_name


def _avatar_data_url(role_id: int) -> str:
    """用 XWUID 的角色头像文件转 data URL；找不到就返回空串（前端会退化成首字）。"""
    import base64

    from .xwuid_bridge import char_avatar_path

    path = char_avatar_path(role_id)
    if path is None:
        return ""
    try:
        raw = path.read_bytes()
    except OSError:
        return ""
    mime = "image/webp" if path.suffix == ".webp" else "image/png"
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def _stamina_for(name: str, bonus: set[str] | None = None) -> int:
    """角色占几个体力点。

    ``bonus`` 是本期矩阵「额外疲劳值」名单（如洛瑟菈），
    命中的一并按 2 点算 —— 和固定 2 点角色叠加不冲突。
    """
    if name in FIXED_STAMINA1:
        return 1
    if name in FIXED_STAMINA2:
        return 2
    if bonus and name in bonus:
        return 2
    return 1


_SKILL_SKIP = {"延奏技能", "谐度破坏"}


def _skill_rows(item: dict) -> list[dict]:
    """技能等级（与练度统计一致：过滤延奏技能/谐度破坏，剩 5 个带等级的）。"""
    rows: list[dict] = []
    for sk in item.get("skillList") or []:
        if not isinstance(sk, dict):
            continue
        info = sk.get("skill") or {}
        if info.get("type") in _SKILL_SKIP:
            continue
        rows.append({"name": str(info.get("name") or ""), "level": int(sk.get("level") or 0)})
    return rows


def load_characters(
    uid: str, *, with_avatar: bool = False, stamina_bonus: set[str] | None = None
) -> list[dict]:
    """读 rawData.json + charListData.json，产出工具箱的角色表。

    返回的 dict 直接喂给前端 ``state.characters``，字段沿用桌面版：
    ``id / name / alias / element / stamina / owned``。
    ``chain`` 与 ``score`` 额外带上，供练度角标使用。

    ``with_avatar=True`` 时把头像压成 data URL（离线单文件分发用）；
    网页版默认不带 —— 头像走 ``/api/avatar/<roleId>``，否则几十人的
    bootstrap 会变成几 MB。
    """
    base = _player_dir(uid)
    raw = _read_json(base / "rawData.json")
    scores = _read_json(base / "charListData.json") or {}
    if not isinstance(raw, list):
        logger.info(f"[ww工具箱] uid={uid} 还没有 rawData.json，角色表返回空（先让用户 ww刷新面板）")
        return []

    name_table = _id2name()
    chain_map: dict[int, int] = {}
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        role = item.get("role") or {}
        role_id = role.get("roleId")
        raw_name = role.get("roleName")
        if not isinstance(role_id, int) or not isinstance(raw_name, str) or not raw_name:
            continue
        name = _canon_name(role_id, raw_name, name_table)

        # 共鸣链：chainList 里 unlocked=True 的条数
        chain = 0
        for chain_item in item.get("chainList") or []:
            if isinstance(chain_item, dict) and chain_item.get("unlocked"):
                chain += 1
        chain_map[role_id] = chain

        score_raw = scores.get(str(role_id))
        score = float(score_raw) if isinstance(score_raw, (int, float)) else None

        star = role.get("starLevel")
        quality = 4 if name in AS_FOUR_STAR else (int(star) if isinstance(star, int) else 5)

        # 双模态（共鸣模态）：skillBranchList + activeBranchId 当前激活分支
        branches = item.get("skillBranchList")
        modal = None
        if isinstance(branches, list) and branches:
            ml = []
            for b in branches:
                if isinstance(b, dict) and b.get("branchId") and b.get("branchName"):
                    ml.append({"id": b.get("branchId"), "name": str(b["branchName"])})
            if ml:
                modal = {"list": ml, "active": item.get("activeBranchId") or ml[0]["id"]}

        out.append(
            {
                "id": str(role_id),
                "name": name,
                "alias": [],
                "element": role.get("attributeName") or "",
                "quality": quality,
                "stamina": _stamina_for(name, stamina_bonus),
                "owned": True,
                "avatar": _avatar_data_url(role_id) if with_avatar else "",
                "level": int(item.get("level") or role.get("level") or 0),
                "chain": chain,
                "score": score,
                "modal": modal,
                "skills": _skill_rows(item),
            }
        )

    # 漂泊者：rawData 里只保留最近刷新的一种属性，rover.json 里有全部。
    # 但 rawData 已经有主角时不能再追加一条 —— 否则前端会出现两张主角卡
    # （112827758 实测：rawData 有 1605 湮灭，rover.json 又补了 1406 气动）。
    if not (set(chain_map) & ROVER_ROLE_IDS):
        out.extend(
            _rover_entries(uid, scores, seen=set(chain_map), with_avatar=with_avatar, stamina_bonus=stamina_bonus)
        )
    # 主角拥有的全部属性（前端切换气泡用它决定哪些项置灰）
    rover_els = _rover_elements(uid)
    if rover_els:
        for c in out:
            try:
                rid = int(c["id"])
            except (TypeError, ValueError):
                continue
            if rid in ROVER_ROLE_IDS:
                c["rover_elements"] = rover_els

    out.sort(key=lambda c: (-(c["quality"] or 0), -(c["score"] or 0), c["name"]))
    logger.info(f"[ww工具箱] uid={uid} 角色表 {len(out)} 人（有评分 {sum(1 for c in out if c['score'] is not None)}）")
    return out


def _rover_elements(uid: str) -> list[str]:
    """从 rover.json 收集账号拥有的主角属性（用于前端切换气泡里置灰未拥有项）。"""
    rover = _read_json(_player_dir(uid) / "rover.json")
    if not isinstance(rover, dict):
        return []
    out: list[str] = []
    for value in rover.values():
        if not isinstance(value, dict):
            continue
        el = (value.get("role") or {}).get("attributeName")
        if isinstance(el, str) and el and el not in out:
            out.append(el)
    return out


def _rover_entries(
    uid: str, scores: dict, seen: set[int], *, with_avatar: bool, stamina_bonus: set[str] | None
) -> list[dict]:
    """把各属性主角合成一条「主角」，等级/链取最高的那条。"""
    rover = _read_json(_player_dir(uid) / "rover.json")
    if not isinstance(rover, dict) or not rover:
        return []

    best: dict | None = None
    for key, value in rover.items():
        if not isinstance(value, dict):
            continue
        role_id = (value.get("role") or {}).get("roleId")
        if isinstance(role_id, int) and role_id in seen:
            continue
        if best is None or int(value.get("level") or 0) > int(best.get("level") or 0):
            best = value
    if best is None:
        return []

    role = best.get("role") or {}
    role_id = role.get("roleId")
    chain = sum(1 for c in (best.get("chainList") or []) if isinstance(c, dict) and c.get("unlocked"))
    score_raw = scores.get(str(role_id)) if role_id else None

    return [
        {
            "id": str(role_id or "rover"),
            "name": "主角",
            "alias": [],
            "element": role.get("attributeName") or "",
            "quality": 5,
            "stamina": _stamina_for("主角", stamina_bonus),
            "owned": True,
            "avatar": (_avatar_data_url(role_id) if with_avatar and isinstance(role_id, int) else ""),
            "level": int(best.get("level") or 0),
            "chain": chain,
            "score": float(score_raw) if isinstance(score_raw, (int, float)) else None,
        }
    ]


def load_account(uid: str) -> dict:
    """账号概览：昵称/等级/世界等级等，取自 baseInfo.json。"""
    info = _read_json(_player_dir(uid) / "baseInfo.json")
    if not isinstance(info, dict):
        return {"uid": uid}
    return {
        "uid": uid,
        "name": info.get("name") or info.get("roleName") or "",
        "level": info.get("level") or info.get("gameLevel") or 0,
        "worldLevel": info.get("worldLevel") or 0,
        "roleNum": info.get("roleNum") or 0,
        "activeDays": info.get("activeDays") or 0,
    }


def has_panel_data(uid: str) -> bool:
    base = _player_dir(uid)
    return (base / "rawData.json").is_file() or (base / "rawData.json.gz").is_file()


async def enrich_with_ranks(uid: str, characters: list[dict]) -> list[dict]:
    """用 XWUID 官方的角色评分接口补齐卡片需要的字段。

    评分等级（c/b/a/s/ss/sss）**必须**走官方 `get_total_score_bg`，
    自己按分数段拍阈值会和 `ww角色列表` 的判定不一致（不同角色上限不同）。
    这里同时拿到中文链名（「三链」）和武器精炼等级，供卡片直接展示。

    失败时原地返回 characters：卡片退化成只有分数，不影响配队功能。
    """
    if not characters:
        return characters
    try:
        from .xwuid_bridge import _waves_module

        expr = _waves_module("utils.expression_ctx")
        model = _waves_module("utils.api.model")

        raw = _read_json(_player_dir(uid) / "rawData.json")
        if not isinstance(raw, list):
            return characters
        details = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                detail = model.RoleDetailData(**item)
            except Exception:
                continue
            details[str(detail.role.roleId)] = detail
        if not details:
            return characters

        ranks = await expr.get_waves_char_rank(uid, details)
    except Exception as exc:  # 评分接口依赖 cython 计算模块，缺了就降级
        logger.warning(f"[ww工具箱] 取官方评分等级失败，卡片降级为纯分数：{exc}")
        return characters

    # 武器信息直接从 rawData 取（rank 里只有 weaponId/精炼，没有名字和星级）
    weapon_map: dict[str, dict] = {}
    raw_items = _read_json(_player_dir(uid) / "rawData.json")
    if isinstance(raw_items, list):
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            role = item.get("role") or {}
            rid = role.get("roleId")
            wdata = item.get("weaponData") or {}
            wd = wdata.get("weapon") or {}
            if rid is None or not wd.get("weaponId"):
                continue
            weapon_map[str(rid)] = {
                "id": str(wd.get("weaponId")),
                "name": str(wd.get("weaponName") or ""),
                "star": int(wd.get("weaponStarLevel") or 3),
                "level": int(wdata.get("level") or 0),
                "breach": int(wdata.get("breach") or 0),
            }

    by_id = {str(r.roleId): r for r in (ranks or [])}
    for c in characters:
        rank = by_id.get(str(c["id"]))
        if rank is None:
            continue
        c["score"] = float(rank.score) if rank.score is not None else c.get("score")
        c["score_bg"] = str(rank.score_bg or "")
        c["chain_name"] = str(rank.chainName or "")
        c["chain"] = int(rank.chain or 0)
        c["weapon_reson"] = int(rank.weaponResonLevel or 0)
        c["sonata"] = str(rank.sonataName or "")
        w = weapon_map.get(str(c["id"]))
        if w:
            c["weapon"] = w
    return characters
