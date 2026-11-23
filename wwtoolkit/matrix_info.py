"""本期矩阵信息：关卡名 / 限时 Buff / 怪物 / 限时强化角色。

数据来自 XWUID 的 wiki 缓存
``data/XutheringWavesUID/resource/map/detail_json/challenge/matrix/{期数}.json``，
由 ``ww矩阵信息`` 指令同一份文件驱动，所以工具箱和指令看到的永远是同一期。

只做只读解析：不触发任何网络请求，也就不存在与指令重复拉取的问题。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from gsuid_core.logger import logger


@dataclass(frozen=True)
class MatrixBuff:
    name: str
    desc: str
    icon: str = ""
    buff_id: int = 0


@dataclass(frozen=True)
class MatrixBoss:
    name: str
    tags: tuple[tuple[str, str], ...]  # (标签名, #rrggbb)
    desc: tuple[str, ...]
    monster_id: int = 0
    icon_url: str = ""
    rounds: int = 1
    unlocked_note: tuple[str, ...] = ()  # 后续轮次才解锁的说明


@dataclass(frozen=True)
class MatrixRole:
    name: str
    role_id: str
    desc: str
    icon: str = ""
    quality: int = 0


@dataclass(frozen=True)
class MatrixInfo:
    period: int
    level_name: str
    buffs: tuple[MatrixBuff, ...]
    bosses: tuple[MatrixBoss, ...]
    roles: tuple[MatrixRole, ...]


def _matrix_dir() -> Path:
    from .xwuid_bridge import matrix_info_dir

    return matrix_info_dir()


def _current_period() -> int:
    """当前期数。取 XWUID 的周期计算；失败时退回「最大的那个 json」。"""
    try:
        from .xwuid_bridge import current_matrix_period

        return current_matrix_period()
    except Exception as exc:  # 周期模块读不到时不该让整个页面挂掉
        logger.warning(f"[ww工具箱] 取当前矩阵期数失败，改用最大期数：{exc}")
        periods = available_periods()
        return periods[-1] if periods else 1


def available_periods() -> list[int]:
    base = _matrix_dir()
    if not base.is_dir():
        return []
    out = []
    for path in base.glob("*.json"):
        if path.stem.isdigit():
            out.append(int(path.stem))
    return sorted(out)


_TAG_RE = re.compile(r"<[^>]+>")
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)


def _clean(text: str) -> str:
    """去掉 wiki 里内联的 HTML（<br> 转换行、其余标签剥掉）。"""
    if not text:
        return ""
    return _TAG_RE.sub("", _BR_RE.sub("\n", text)).strip()


def _pick_level(data: dict) -> dict | None:
    levels = data.get("Levels") or []
    if not levels:
        return None
    # 与指令一致：优先「奇点扩张」，没有就取最后一个
    for level in levels:
        if isinstance(level, dict) and level.get("Name") == "奇点扩张":
            return level
    return levels[-1] if isinstance(levels[-1], dict) else None


def _tag_color(raw: str) -> str:
    """wiki 的颜色是 8 位 ``RRGGBBAA``（后两位 alpha 实测恒为 ff，例如 55ffb5ff 是青绿）。
    """
    if not raw:
        return ""
    text = str(raw).strip().lstrip("#")
    digits = "".join(ch for ch in text if ch.isalnum())
    if len(digits) == 8:
        # 格式是 RRGGBBAA：后两位才是 alpha。55ffb5ff → #55ffb5（青绿）
        digits = digits[:6]
    if len(digits) != 6:
        return ""
    return "#" + digits.lower()


def _waves_to_bosses(waves: list[dict]) -> tuple[MatrixBoss, ...]:
    """从 Waves 里取怪物，按名字去重合并轮次（与 `ww矩阵信息` 指令同样的口径）。

    Waves 是按轮次平铺的：同一只 boss 在 R1/R2/R3 各出现一次。
    指令的做法是按名去重、后续轮次里新增的说明标成「轮次N解锁」，
    这里保持一致，前端才不会显示 15 条重复名字。
    """
    merged: dict[str, dict] = {}
    order: list[str] = []

    for wave in waves or []:
        if not isinstance(wave, dict):
            continue
        name = str(wave.get("Name") or wave.get("MonsterName") or "").strip()
        if not name:
            continue

        tag_pairs: list[tuple[str, str]] = []
        for tag in wave.get("Tags") or []:
            if isinstance(tag, dict) and tag.get("Name"):
                tag_pairs.append((str(tag["Name"]), _tag_color(tag.get("Color", ""))))

        desc_lines: list[str] = []
        for key in ("Desc", "Description", "BuffDesc"):
            raw = wave.get(key)
            if isinstance(raw, str) and raw.strip():
                # 一条 Desc 里可能用 <br> 分多行
                for part in _BR_RE.split(raw):
                    cleaned = _clean(part)
                    if cleaned and cleaned != name:
                        desc_lines.append(cleaned)

        existing = merged.get(name)
        if existing is None:
            merged[name] = {
                "name": name,
                "tags": tag_pairs,
                "desc": desc_lines,
                "monster_id": int(wave.get("MonsterId") or 0),
                "icon_url": str(wave.get("Icon") or ""),
                "rounds": 1,
                "unlocked_note": [],
            }
            order.append(name)
            continue

        existing["rounds"] += 1
        for line in desc_lines:
            if not any(line in seen for seen in existing["desc"]):
                existing["unlocked_note"].append(f"轮次{existing['rounds']}解锁：{line}")
            # 后面轮次才出现的标签也补上
        for pair in tag_pairs:
            if pair not in existing["tags"]:
                existing["tags"].append(pair)
        if not existing["icon_url"] and wave.get("Icon"):
            existing["icon_url"] = str(wave["Icon"])

    return tuple(
        MatrixBoss(
            name=item["name"],
            tags=tuple(item["tags"]),
            desc=tuple(item["desc"]),
            monster_id=item["monster_id"],
            icon_url=item["icon_url"],
            rounds=item["rounds"],
            unlocked_note=tuple(item["unlocked_note"]),
        )
        for item in (merged[name] for name in order)
    )


def load_matrix_info(period: int | None = None) -> MatrixInfo | None:
    """读某一期的矩阵信息。缺文件返回 None（前端会隐藏这一块）。"""
    base = _matrix_dir()
    if not base.is_dir():
        return None
    target = period if period is not None else _current_period()
    path = base / f"{target}.json"
    if not path.is_file():
        # 指定期数不存在时退回最新一期，避免整块区域变成空白
        periods = available_periods()
        if not periods:
            return None
        target = periods[-1]
        path = base / f"{target}.json"

    try:
        import json

        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning(f"[ww工具箱] 读取矩阵 {target}.json 失败：{exc}")
        return None
    if not isinstance(data, dict):
        return None

    level = _pick_level(data)
    if level is None:
        return None

    # bosses 覆盖全部关卡（稳态协议 + 奇点扩张）：每轮的怪物都要有头像与特性
    all_waves: list[dict] = []
    for lv in data.get("Levels") or []:
        if isinstance(lv, dict):
            for w in lv.get("Waves") or []:
                if isinstance(w, dict):
                    all_waves.append(w)

    buffs = tuple(
        MatrixBuff(
            name=str(b.get("Name") or "增益"),
            desc=_clean(str(b.get("Desc") or "")),
            icon=str(b.get("Icon") or ""),
            buff_id=int(b.get("Id") or 0),
        )
        for b in (level.get("NewTowerBuffs") or [])
        if isinstance(b, dict)
    )

    roles: list[MatrixRole] = []
    for item in data.get("Roles") or []:
        if not isinstance(item, dict):
            continue
        info = item.get("RoleInfo") or {}
        name = str(info.get("Name") or "").strip()
        if not name:
            continue
        descs = item.get("EnhanceSkillDesc") or []
        desc = _clean(str(descs[0].get("Value") or "")) if descs and isinstance(descs[0], dict) else ""
        roles.append(
            MatrixRole(
                name=name,
                role_id=str(item.get("Id") or ""),
                desc=desc,
                icon=str(info.get("RoleHeadIcon") or ""),
                quality=int(info.get("QualityId") or 0),
            )
        )

    return MatrixInfo(
        period=target,
        level_name=str(level.get("Name") or ""),
        buffs=buffs,
        bosses=_waves_to_bosses(all_waves),
        roles=tuple(roles),
    )


def stamina_bonus_roles(info: MatrixInfo | None) -> set[str]:
    """从强化描述里认出「额外疲劳值 / 体力」的角色 —— 这些人在本期是 ×2 点。

    文案实测为「角色拥有额外疲劳值（限S2第4阶段）」，用宽松关键字匹配，
    以后换成「额外体力」「疲劳值提升」之类的措辞也能命中。
    """
    if info is None:
        return set()
    marks = ("疲劳", "体力", "点数")
    out: set[str] = set()
    for role in info.roles:
        if any(mark in role.desc for mark in marks):
            out.add(role.name)
    return out
