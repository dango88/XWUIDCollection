"""工具箱存档表：把「一次配队会话的全部状态」存进 gsuid_core 的数据库。

为什么用数据库而不是 JSON 文件：
- 与 XWUID 的用户/绑定表同一套 sqlmodel 基建，备份与迁移跟着 core 走；
- 服务器上 core 已有 sqlite，不额外引入落盘格式；
- 一个用户一行，读写天然按主键收敛，不会出现「半截 JSON」。

表结构刻意做得极窄：存档本体是一个 JSON 文本（前端 13 个 mc_* 键原样打包），
只有 ``user_id/bot_id/uid`` 与更新时间是可查询列。这样可以跟着前端版本演进，
不需要每次加字段都迁表。
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, Optional

from sqlmodel import Field, col, select
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from gsuid_core.logger import logger
from gsuid_core.utils.database.base_models import BaseBotIDModel, with_session

# 前端允许落库的键（与桌面版 LS_KEYS 保持一致）
ALLOWED_KEYS = frozenset(
    {
        "mc_characters",
        "mc_rules",
        "mc_presets",
        "mc_snapshots",
        "mc_current",
        "mc_seed_seen",
        "mc_ui_flags",
        "mc_team_done",
        "mc_matrix",
        "mc_team_names",
        "mc_config_scores",
        "mc_rule_mainc_priority",
        "mc_rule_mainc_rule_order",
        # 新版（Open Design 原型）页面的整体状态包
        "od_state",
    }
)

# 整包上限：角色头像走 XWUID 图片接口，不进存档，正常 < 1MB
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024


class WavesToolkitState(BaseBotIDModel, table=True):
    """一个用户一行。``payload`` 是 {mc_*: value} 的 JSON 文本。"""

    __tablename__ = "WavesToolkitState"
    __table_args__: Dict[str, Any] = {"extend_existing": True}

    user_id: str = Field(title="账号")
    uid: str = Field(default="", title="鸣潮UID")
    payload: str = Field(default="{}", title="存档JSON")
    updated_at: int = Field(default=0, title="更新时间戳")

    @classmethod
    @with_session
    async def load(
        cls,
        session: AsyncSession,
        user_id: str,
        bot_id: str = "",
    ) -> Dict[str, Any]:
        result = await session.scalars(
            select(cls).where(col(cls.user_id) == user_id).where(col(cls.bot_id) == bot_id)
        )
        row = result.first()
        if row is None or not row.payload:
            return {}
        try:
            data = json.loads(row.payload)
        except ValueError as exc:
            logger.warning(f"[ww工具箱] 存档解析失败 user={user_id}: {exc}")
            return {}
        if not isinstance(data, dict):
            return {}
        return {k: v for k, v in data.items() if k in ALLOWED_KEYS}

    @classmethod
    @with_session
    async def store(
        cls,
        session: AsyncSession,
        user_id: str,
        bot_id: str,
        payload: Dict[str, Any],
        uid: str = "",
    ) -> int:
        """整包覆盖写。返回写入的字节数。

        不在白名单的键直接丢弃 —— 前端被注入也塞不进垃圾。
        """
        # 角色表由 XWUID 数据实时生成，头像走 /api/avatar 接口 ——
        # 存档里再存一份 base64 头像只是把同一张图存两遍（实测 3 人就 513KB）。
        # 这里落库前剥掉 avatar 字段，读回时前端会重新从后端拉。
        import copy

        clean = copy.deepcopy({k: v for k, v in payload.items() if k in ALLOWED_KEYS})
        chars = clean.get("mc_characters")
        if isinstance(chars, list):
            for c in chars:
                if isinstance(c, dict):
                    c.pop("avatar", None)

        encoded = json.dumps(clean, ensure_ascii=False, separators=(",", ":"))
        size = len(encoded.encode("utf-8"))
        if size > MAX_PAYLOAD_BYTES:
            raise ValueError(f"存档过大：{size} 字节超过上限 {MAX_PAYLOAD_BYTES}")

        result = await session.scalars(
            select(cls).where(col(cls.user_id) == user_id).where(col(cls.bot_id) == bot_id)
        )
        row = result.first()
        now = int(time.time())
        if row is None:
            row = cls(user_id=user_id, bot_id=bot_id, uid=uid, payload=encoded, updated_at=now)
            session.add(row)
        else:
            row.payload = encoded
            row.updated_at = now
            if uid:
                row.uid = uid
            session.add(row)
        await session.commit()
        return size

    @classmethod
    @with_session
    async def clear(cls, session: AsyncSession, user_id: str, bot_id: str) -> bool:
        result = await session.execute(
            delete(cls).where(col(cls.user_id) == user_id).where(col(cls.bot_id) == bot_id)
        )
        await session.commit()
        return bool(result.rowcount)


async def ensure_table() -> None:
    """确保表存在。

    core 启动时会对 SQLModel.metadata 做一次 create_all；只要本模块被 import，
    ``WavesToolkitState`` 就进了 metadata，表自然会被建出来。这里额外做一次
    ``create_all`` 只为覆盖「插件在 core 启动之后才热重载」的场景。
    """
    from sqlmodel import SQLModel

    try:
        from gsuid_core.utils.database import base_models

        engine = getattr(base_models, "_ENGINE", None) or getattr(base_models, "ENGINE", None)
        if engine is None:
            # 拿不到引擎句柄时不强求：core 自己的 create_all 已经覆盖了模型
            logger.info("[ww工具箱] 存档表随 core 首次 create_all 建立")
            return
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        logger.info("[ww工具箱] 存档表就绪 (WavesToolkitState)")
    except Exception as exc:  # 表建不出来时网页仍可用，只是存档会失败
        logger.warning(f"[ww工具箱] 建表失败：{exc}")


def load_sync_hint() -> Optional[str]:
    """给文档/日志用的一句话说明，不参与逻辑。"""
    return "存档存于 core 数据库 WavesToolkitState 表，按 user_id+bot_id 唯一"
