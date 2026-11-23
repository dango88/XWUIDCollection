"""一次性 token 池：按 XWUID 抽卡页的做法（secrets.token_urlsafe + 内存缓存），
但取用即销毁 —— 链接发出去只能打开一次。

为什么不用 HMAC 自签令牌（之前的实现）：
- 自签令牌无状态，无法「用一次就失效」——只能等它自然过期；
- 抽卡页那套内存 token 池天然支持单次消费，且服务端可随时清空。

安全取舍：
- token 是 128 bit 随机串，不可猜测；
- 消费后立刻从池里删除，重放直接 404；
- 未消费的 token 有 TTL（默认 10 分钟），过期即失效；
- 池上限防内存爆炸。
"""

from __future__ import annotations

import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass

# 未使用的链接多久失效。参考抽卡页的 10 分钟。
DEFAULT_TTL = 600

# 池容量上限。每个 state 只有几百字节，2000 条约 1MB。
MAX_ENTRIES = 2000


@dataclass(frozen=True)
class Ticket:
    user_id: str
    bot_id: str
    session_id: str
    issued_at: float


class TicketPool:
    """线程安全的一次性票据池。

    抽卡页用的是 TimedCache（可重复读）；这里刻意不同：``consume`` 取到即删，
    保证「发一次链接只能打开一次」。页面刷新/多次请求靠页面内的短期会话维持，
    不靠复用链接。
    """

    def __init__(self, ttl: int = DEFAULT_TTL, maxsize: int = MAX_ENTRIES) -> None:
        self._ttl = ttl
        self._maxsize = maxsize
        self._items: OrderedDict[str, tuple[Ticket, float]] = OrderedDict()

    def _gc(self) -> None:
        now = time.monotonic()
        dead = [k for k, (_, exp) in self._items.items() if exp <= now]
        for k in dead:
            self._items.pop(k, None)
        while len(self._items) > self._maxsize:
            self._items.popitem(last=False)

    def issue(self, user_id: str, bot_id: str, session_id: str, ttl: int | None = None) -> str:
        self._gc()
        token = secrets.token_urlsafe(16)
        life = self._ttl if ttl is None else ttl
        self._items[token] = (
            Ticket(
                user_id=user_id,
                bot_id=bot_id,
                session_id=session_id,
                issued_at=time.time(),
            ),
            time.monotonic() + life,
        )
        return token

    def consume(self, token: str) -> Ticket | None:
        """取出并销毁。第二次调用同一 token 一定返回 None。"""
        if not token:
            return None
        self._gc()
        entry = self._items.pop(token, None)
        if entry is None:
            return None
        ticket, expires = entry
        if expires <= time.monotonic():
            return None
        return ticket

    def peek(self, token: str) -> Ticket | None:
        """只读检查，不消费。给「页面内的后续请求」用。"""
        self._gc()
        entry = self._items.get(token)
        if entry is None:
            return None
        ticket, expires = entry
        if expires <= time.monotonic():
            self._items.pop(token, None)
            return None
        return ticket

    def revoke(self, token: str) -> bool:
        return self._items.pop(token, None) is not None

    def size(self) -> int:
        self._gc()
        return len(self._items)


pool = TicketPool()


@dataclass(frozen=True)
class Session:
    """链接被消费后建立的浏览器会话。页面后续请求用它，与一次性链接解耦。"""

    sid: str
    user_id: str
    bot_id: str
    expires_at: float


class SessionPool:
    """网页会话：token 消费一次后发一个 cookie 会话，页面刷新不再消耗链接。

    TTL 默认 12 小时 —— 与「配一次队」的实际时长匹配，但比原来的 12 小时
    token 更收敛：链接本身 10 分钟内不用就废，用掉后也只能撑这一场会话。
    """

    def __init__(self, ttl: int = 12 * 3600, maxsize: int = 4000) -> None:
        self._ttl = ttl
        self._maxsize = maxsize
        self._items: OrderedDict[str, tuple[Session, float]] = OrderedDict()

    def _gc(self) -> None:
        now = time.monotonic()
        dead = [k for k, (_, exp) in self._items.items() if exp <= now]
        for k in dead:
            self._items.pop(k, None)
        while len(self._items) > self._maxsize:
            self._items.popitem(last=False)

    def create(self, user_id: str, bot_id: str) -> Session:
        self._gc()
        sid = secrets.token_urlsafe(24)
        sess = Session(sid=sid, user_id=user_id, bot_id=bot_id, expires_at=time.time() + self._ttl)
        self._items[sid] = (sess, time.monotonic() + self._ttl)
        return sess

    def get(self, sid: str | None) -> Session | None:
        if not sid:
            return None
        self._gc()
        entry = self._items.get(sid)
        if entry is None:
            return None
        sess, expires = entry
        if expires <= time.monotonic():
            self._items.pop(sid, None)
            return None
        return sess

    def destroy(self, sid: str) -> bool:
        return self._items.pop(sid, None) is not None


sessions = SessionPool()

# cookie 名，__Host- 前缀要求 https + Path=/ + 无 Domain；本地 http 调试用普通名
COOKIE_NAME = "mc_toolkit_sid"

class LongLinkPool:
    """长效链接：可反复访问，用于自己调试、把页面发给设计工具参考等。

    与一次性 ticket 的区别：
    - 不消费，每次打开都发一个新的浏览器会话；
    - 默认 7 天有效，可按 key 吊销；
    - 仍然随机生成 128bit key，不可猜。
    """

    def __init__(self, ttl: int = 7 * 24 * 3600, maxsize: int = 200) -> None:
        self._ttl = ttl
        self._maxsize = maxsize
        self._items: OrderedDict[str, tuple[Ticket, float]] = OrderedDict()

    def _gc(self) -> None:
        now = time.monotonic()
        dead = [k for k, (_, exp) in self._items.items() if exp <= now]
        for k in dead:
            self._items.pop(k, None)
        while len(self._items) > self._maxsize:
            self._items.popitem(last=False)

    def issue(
        self, user_id: str, bot_id: str, session_id: str = "", ttl: int | None = None
    ) -> str:
        self._gc()
        key = secrets.token_urlsafe(18)
        life = self._ttl if ttl is None else ttl
        self._items[key] = (
            Ticket(user_id=user_id, bot_id=bot_id, session_id=session_id, issued_at=time.time()),
            time.monotonic() + life,
        )
        return key

    def get(self, key: str) -> Ticket | None:
        """只读取用：不销毁，可以反复打开。"""
        self._gc()
        entry = self._items.get(key)
        if entry is None:
            return None
        ticket, expires = entry
        if expires <= time.monotonic():
            self._items.pop(key, None)
            return None
        return ticket

    def revoke(self, key: str) -> bool:
        return self._items.pop(key, None) is not None

    def size(self) -> int:
        return len(self._items)


long_links = LongLinkPool()
