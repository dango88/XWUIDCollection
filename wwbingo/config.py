import random
from typing import Dict, List, Tuple, Optional

from gsuid_core.data_store import get_res_path
from gsuid_core.utils.plugins_config.models import (
    GSC,
    GsBoolConfig,
    GsIntConfig,
    GsListStrConfig,
)
from gsuid_core.utils.plugins_config.gs_config import StringConfig

from .char_data import FIVE_STAR_IDS, FOUR_STAR_IDS, ROVER_IDS, has_head

CONFIG_PATH = get_res_path("XWUIDCollection") / "config.json"

DEFAULT_BINGO_ROWS = 6
DEFAULT_BINGO_COLUMNS = 6
MIN_BINGO_SIDE = 2

# 参考顺序按从左到右、从上到下排列，实际使用数量由棋盘行列配置决定。
REFERENCE_BINGO_IDS: List[int] = [
    1211, 1605, 1510, 1507, 1207, 1107,
    1508, 1410, 1209, 1205, 1305, 1105,
    1206, 1607, 1208, 1503, 1104, 1306,
    1302, 1506, 1603, 1108, 1404, 1405,
    1505, 1509, 1407, 1301, 1409, 1210,
    1203, 1412, 1606, 1608, 1304, 1411,
]

CONFIG_DEFAULT: Dict[str, GSC] = {
    "BingoColumns": GsIntConfig(
        "宾果横向格数（列）",
        "棋盘每行显示的角色数量，最小为 2，不设上限",
        DEFAULT_BINGO_COLUMNS,
    ),
    "BingoRows": GsIntConfig(
        "宾果纵向格数（行）",
        "棋盘纵向显示的角色数量，最小为 2，不设上限",
        DEFAULT_BINGO_ROWS,
    ),
    "BingoRoleIds": GsListStrConfig(
        "宾果角色ID（行优先，留空随机）",
        "按横向格数×纵向格数读取角色ID，从左到右、从上到下排列；不足时随机补齐",
        [],
    ),
    "BingoWith4Star": GsBoolConfig(
        "随机时带四星",
        "随机生成棋盘时是否把四星也算进去；五星不足以填满棋盘时会自动加入四星",
        False,
    ),
}

XWUIDCollectionConfig = StringConfig("XWUIDCollection", CONFIG_PATH, CONFIG_DEFAULT)


def _get_side(config_name: str, default: int) -> int:
    try:
        value = int(XWUIDCollectionConfig.get_config(config_name).data)
    except (TypeError, ValueError):
        value = default
    return max(MIN_BINGO_SIDE, value)


def get_bingo_layout() -> Tuple[int, int]:
    rows = _get_side("BingoRows", DEFAULT_BINGO_ROWS)
    columns = _get_side("BingoColumns", DEFAULT_BINGO_COLUMNS)
    return rows, columns


def _random_bingo_ids(count: int, excluded: Optional[List[int]] = None) -> List[int]:
    excluded_ids = set(excluded or [])
    pool = [c for c in FIVE_STAR_IDS if c not in excluded_ids and has_head(c)]
    rovers = [r for r in ROVER_IDS if r not in excluded_ids and has_head(r)]

    picks: List[int] = []
    has_rover = bool(excluded_ids & set(ROVER_IDS))
    if rovers and count > 0 and not has_rover:
        picks.append(random.choice(rovers))

    need = count - len(picks)
    with_four_star = XWUIDCollectionConfig.get_config("BingoWith4Star").data
    if with_four_star or need > len(pool):
        pool += [c for c in FOUR_STAR_IDS if c not in excluded_ids and has_head(c)]
    picks += random.sample(pool, min(need, len(pool)))
    random.shuffle(picks)
    return picks[:count]


def get_bingo_ids(count: int) -> List[int]:
    raw = XWUIDCollectionConfig.get_config("BingoRoleIds").data or []
    ids: List[int] = []
    for value in raw:
        try:
            ids.append(int(str(value).strip()))
        except (TypeError, ValueError):
            continue
    if not ids:
        return _random_bingo_ids(count)
    if len(ids) < count:
        ids += _random_bingo_ids(count - len(ids), excluded=ids)
    return ids[:count]
