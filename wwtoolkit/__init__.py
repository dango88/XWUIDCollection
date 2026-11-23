"""ww工具箱：鸣潮配队工具箱（从 wc-upload 桌面版移植到网页）。

群里发 ``ww配队`` → bot 回一个**一次性**链接（参考 XWUID 抽卡页的做法）：
``{base}/waves/toolkit/{token}``。链接打开一次即销毁，10 分钟内不打开也作废；
打开后靠 HttpOnly 会话 cookie 维持这一场使用。

存档按用户隔离、云端保存，与 gsuid_core 的 WebConsole 同一端口。
"""

from __future__ import annotations

from gsuid_core.bot import Bot
from gsuid_core.logger import logger
from gsuid_core.models import Event
from gsuid_core.sv import SV

from .config import link_ttl_minutes, public_base
from .ticket import pool

sv_toolkit = SV("ww配队工具箱", priority=5)

# 网页挂载的路径前缀，与 routes.py 的 router prefix 一致
PAGE_PREFIX = "/waves/toolkit"

_INSTRUCTION = """\
【鸣潮配队工具箱】

{url}

⚠️ 这个链接只能用一次，{ttl} 分钟内有效，别转发。
打开后就能用：角色池 / 管理角色 / 绑定规则 / 主C优先级 / 方案存档，改动自动云端保存。
"""


def _base_url(ev: Event) -> str:
    """推导对用户可达的 scheme+host。

    优先用控制台配置的公开地址（反代后面时 request.base_url 是内网地址，
    直接发出去用户打不开）；没配置就退回本机监听地址。
    """
    configured = public_base()
    if configured:
        return configured.rstrip("/")

    try:
        from gsuid_core.config import core_config

        host = core_config.get_config("host") or "127.0.0.1"
        port = core_config.get_config("port") or 8765
    except Exception:  # 配置读取不该让指令整个失败
        host, port = "127.0.0.1", 8765
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    return f"http://{host}:{port}"


@sv_toolkit.on_command(
    ("配队工具箱", "配队", "toolkit"),
    block=True,
    to_ai="""打开鸣潮配队工具箱网页。生成一个只能使用一次、10 分钟内有效的链接，用户在浏览器打开即可用桌面版的全部配队功能（角色池、绑定规则、主C优先级、方案存档），存档按用户云端保存。

当用户说「配队」「配队工具」「打开配队工具箱」「帮我排队」时调用。
""",
)
async def send_toolkit_link(bot: Bot, ev: Event) -> None:
    # 与 XWUID 的其它功能保持一致：没绑定特征码就不签发链接，
    # 避免用户拿到链接打开后才发现没有角色数据。
    from .xwuid_bridge import prefix, resolve_uid

    uid = await resolve_uid(ev.user_id, ev.bot_id)
    if not uid:
        await bot.send(
            f"还没绑定特征码呢，先 {prefix()}绑定 再来用配队工具箱吧~",
            at_sender=True,
        )
        return

    # 面板数据也要有，否则进去是空角色池
    from .xwuid_data import has_panel_data

    if not has_panel_data(uid):
        await bot.send(
            f"本地还没有你的角色面板数据，先发 {prefix()}刷新面板 更新后再来~",
            at_sender=True,
        )
        return

    ttl_min = link_ttl_minutes()
    token = pool.issue(
        user_id=ev.user_id,
        bot_id=ev.bot_id,
        session_id=ev.session_id or "",
        ttl=ttl_min * 60,
    )
    url = f"{_base_url(ev)}{PAGE_PREFIX}/{token}"
    logger.info(f"[ww工具箱] 为 {ev.user_id}@{ev.bot_id} (uid={uid}) 签发一次性链接（TTL {ttl_min} 分钟）")
    await bot.send(
        _INSTRUCTION.format(url=url, ttl=ttl_min),
        at_sender=True,
    )
