from gsuid_core.data_store import get_res_path
from gsuid_core.utils.plugins_config.gs_config import StringConfig
from gsuid_core.utils.plugins_config.models import GSC, GsBoolConfig, GsStrConfig

CONFIG_PATH = get_res_path("XWUIDCollection") / "toolkit.json"

CONFIG_DEFAULT: dict[str, GSC] = {
    "ToolkitPublicBase": GsStrConfig(
        "网页对外地址",
        "发给用户的链接前缀，例如 https://bot.example.com。留空则用 core 监听的 host:port"
        "（本机测试可用，外网/反代环境必须填）",
        "",
    ),
    "ToolkitLinkTTL": GsStrConfig(
        "链接有效期(分钟)",
        "一次性链接多久内必须打开，默认 10（参考抽卡页）。打开后会话可延续 12 小时",
        "10",
    ),
    "ToolkitDevTicket": GsBoolConfig(
        "调试签发开关",
        "开启后可在本机 POST /waves/toolkit/api/_dev_ticket 直接拿链接，免去在群里发指令。"
        "仅回环地址可用，正式环境请关闭",
        False,
    ),
    "ToolkitAdminPassword": GsStrConfig(
        "预设管理密码",
        "预设配队管理页（#admin）的登录密码，留空则管理页禁用",
        "",
    ),
}

ToolkitConfig = StringConfig("XWUIDCollectionToolkit", CONFIG_PATH, CONFIG_DEFAULT)


def public_base() -> str:
    raw = ToolkitConfig.get_config("ToolkitPublicBase").data
    return str(raw or "").strip()


def link_ttl_minutes() -> int:
    raw = str(ToolkitConfig.get_config("ToolkitLinkTTL").data or "10").strip()
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 10
    # 5 分钟 ~ 24 小时，超范围回默认。太短用户来不及点，太长就失去一次性意义
    return value if 5 <= value <= 1440 else 10


def dev_ticket_enabled() -> bool:
    return bool(ToolkitConfig.get_config("ToolkitDevTicket").data)

def admin_password() -> str:
    return str(ToolkitConfig.get_config("ToolkitAdminPassword").data or "").strip()
