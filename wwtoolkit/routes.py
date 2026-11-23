"""网页端 FastAPI 路由：一次性链接 + 会话 cookie + XWUID 数据与数据库存档。

路径设计参考 XutheringWavesUID 的抽卡页（``/waves/gacha/{token}``）：
指令发 ``/waves/toolkit/{token}``，token 在 URL 路径上。

与抽卡页的关键差异：
- **链接只能用一次**。打开即从池里销毁，重放拿到「链接已失效」页。
- 消费成功后种 HttpOnly 会话 cookie，页面内后续请求（存档读写、刷新）靠会话。
- 角色池数据来自 XWUID 的本地落盘（rawData.json / charListData.json），
  存档写 core 数据库的 WavesToolkitState 表 —— 都不再落 JSON 文件。
"""

from __future__ import annotations

import json
import secrets
import time
from collections import defaultdict, deque
from json import JSONDecodeError
from pathlib import Path
from typing import Deque
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response

from gsuid_core.logger import logger

from . import config, db, matrix_info as matrix_info_mod, xwuid_bridge, xwuid_data
from .ticket import COOKIE_NAME, Session, long_links, pool, sessions

_STATIC = Path(__file__).parent / "static"
_DATA = Path(__file__).parent / "data"


def _read_json(name: str) -> object:
    """读随插件发布的静态数据（目前只有矩阵表）。缺失/损坏都返回 None。"""
    path = _DATA / name
    if not path.is_file():
        logger.warning(f"[ww工具箱] 静态数据缺失：{path}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning(f"[ww工具箱] 静态数据 {name} 解析失败：{exc}")
        return None

router = APIRouter(prefix="/waves/toolkit", tags=["ww-toolkit"])

_mounted = False

# 每个会话 10 分钟内最多 400 次数据请求（保存是 320ms 防抖，正常远低于此）
_RATE_WINDOW = 600.0
_RATE_LIMIT = 400
_hits: dict[str, Deque[float]] = defaultdict(deque)


def mount() -> None:
    """把路由挂到 core 的 FastAPI app 上。

    XWUIDCollection 被 gsuid_core 导入时调用一次；重复调用直接跳过，
    避免热重载时同一批路由被注册两遍（Starlette 会直接抛 duplicate route）。
    """
    global _mounted
    if _mounted:
        return
    from gsuid_core.web_app import app

    app.include_router(router)
    _mounted = True
    logger.info(f"[ww工具箱] 路由已挂载：/waves/toolkit/ (static={_STATIC.is_dir()})")


_NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
}

_INVALID_HTML = """<!DOCTYPE html><html lang=zh-CN><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>链接已失效</title>
<style>
html,body{height:100%;margin:0;background:#0e1116;color:#e6edf3;
font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
display:flex;align-items:center;justify-content:center}
.box{padding:32px 36px;border:1px solid #30363d;border-radius:12px;
background:#161b22;max-width:460px;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.5)}
h1{font-size:18px;margin:0 0 10px;color:#d29922}
p{font-size:13px;color:#8b949e;line-height:1.8;margin:6px 0}
code{background:#222b36;padding:2px 6px;border-radius:4px;color:#4cc2ff}
</style>
<div class=box><h1>链接已失效</h1>
<p>__REASON__</p>
<p>请回到群里重新发送 <code>ww配队</code> 获取新链接。</p>
<p style="color:#6e7681;font-size:12px;margin-top:14px">
链接一次有效，10 分钟内不打开也会作废。</p></div></html>"""


_ENTER_SHIM = """<!DOCTYPE html><html lang=zh-CN><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>正在进入配队工具箱</title>
<style>
html,body{height:100%;margin:0;background:#0e1116;color:#e6edf3;
font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
display:flex;align-items:center;justify-content:center}
.box{padding:30px 34px;border:1px solid #30363d;border-radius:12px;
background:#161b22;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.5)}
h1{font-size:17px;margin:0 0 8px;color:#e6edf3}
p{font-size:13px;color:#8b949e;margin:0;line-height:1.8}
.btn{display:inline-block;margin-top:16px;padding:8px 18px;border-radius:8px;
background:#2f81f7;color:#fff;text-decoration:none;font-size:13px}
</style>
<div class=box>
<h1 id=t>正在进入配队工具箱…</h1>
<p id=m>若没有自动跳转，点下面的按钮</p>
<a class=btn id=b href="__GO__">手动进入</a>
</div>
<script>
var TOKEN = __TOKEN__;
var btn = document.getElementById('b');
fetch('/waves/toolkit/api/enter', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'same-origin',
  body: JSON.stringify({ token: TOKEN })
}).then(function (r) { return r.json(); }).then(function (d) {
  if (d && d.ok) {
    btn.href = '/waves/toolkit/';
    btn.textContent = '进入工具箱';
    location.replace('/waves/toolkit/');
  } else {
    document.getElementById('t').textContent = '链接已失效';
    document.getElementById('m').textContent =
      (d && d.error) || '这个链接已经用过了，或者超过 10 分钟没有打开。';
  }
}).catch(function () {
  document.getElementById('m').textContent = '网络异常，可点下方按钮重试';
});
</script>
"""


def _enter_shim(token: str) -> HTMLResponse:
    """一次性链接的中转页：只渲染、不消费。

    为什么消费不能放在 GET 里：群里发出链接后，QQ/微信的链接预览爬虫会在几秒内
    从多个机房并发 GET 这个地址。若 GET 就消费，用户点开时票据早被爬虫用掉，
    永远只能看到「链接已失效」。真正的消费放在页面内 POST /api/enter ——
    爬虫不执行 JS，不会碰。不执行 JS 的浏览器走页面上的「手动进入」按钮。
    """
    go = f"/waves/toolkit/{quote(token, safe='')}/go"
    html = _ENTER_SHIM.replace("__TOKEN__", json.dumps(token)).replace("__GO__", go)
    return HTMLResponse(html, headers=_NO_STORE_HEADERS)


def _consume_into_session(token: str) -> Response | None:
    """消费一次性票据并种会话 cookie。失败（已用/过期/不存在）返回 None。"""
    ticket = pool.consume(token)
    if ticket is None:
        return None
    sess = sessions.create(ticket.user_id, ticket.bot_id)
    logger.info(f"[ww工具箱] token 已消费 → 会话 {sess.sid[:8]}… ({ticket.user_id}@{ticket.bot_id})")
    resp = RedirectResponse(url="/waves/toolkit/", status_code=303)
    _set_session_cookie(resp, sess.sid)
    resp.headers.update(_NO_STORE_HEADERS)
    return resp


def _invalid(reason: str, status: int = 200) -> HTMLResponse:
    # 上游 nginx 常把 4xx 换成默认错误页，用 200 + 页内提示更稳（抽卡页同款取舍）
    # 用 replace 而不是 format：模板里满是 CSS 花括号，format 会把它们当占位符
    return HTMLResponse(
        _INVALID_HTML.replace("__REASON__", reason), status_code=status, headers=_NO_STORE_HEADERS
    )


# ---------- 会话 ----------


def _session_from(request: Request) -> Session | None:
    return sessions.get(request.cookies.get(COOKIE_NAME))


def _require_session(request: Request) -> Session:
    sess = _session_from(request)
    if sess is None:
        raise HTTPException(status_code=401, detail="会话已过期，请回群里重新发送 ww配队")
    if not _rate_ok(sess.sid):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    return sess


def _rate_ok(sid: str) -> bool:
    now = time.monotonic()
    bucket = _hits[sid]
    while bucket and now - bucket[0] > _RATE_WINDOW:
        bucket.popleft()
    if len(bucket) >= _RATE_LIMIT:
        return False
    bucket.append(now)
    return True


def _set_session_cookie(resp: Response, sid: str) -> Response:
    resp.set_cookie(
        COOKIE_NAME,
        sid,
        max_age=12 * 3600,
        httponly=True,
        samesite="lax",
        path="/waves/toolkit",
    )
    return resp


# ---------- 页面 ----------


@router.get("/long/{key}", response_class=HTMLResponse, include_in_schema=False)
async def enter_long(key: str) -> Response:
    """长效入口：可反复打开，每次发一个新会话。用于调试 / 给外部工具看真实页面。

    与一次性 ticket 的区别是「不消费」——同一个 key 可以刷新、重开。
    """
    ticket = long_links.get(key)
    if ticket is None:
        return _invalid("这个长效链接已过期或被吊销。")

    sess = sessions.create(ticket.user_id, ticket.bot_id)
    resp = RedirectResponse(url="/waves/toolkit/", status_code=303)
    _set_session_cookie(resp, sess.sid)
    resp.headers.update(_NO_STORE_HEADERS)
    return resp


@router.get("/{token}", response_class=HTMLResponse, include_in_schema=False)
async def enter(token: str) -> Response:
    """一次性入口：只回中转页，**不消费**票据。

    消费放在页面内的 POST /api/enter（或「手动进入」按钮的 /{token}/go），
    否则群里链接刚发出去就会被 QQ/微信的预览爬虫抢先用掉。
    """
    return _enter_shim(token)


@router.get("/{token}/go", response_class=HTMLResponse, include_in_schema=False)
async def enter_go(token: str) -> Response:
    """中转页「手动进入」的落点：给不执行 JS 的浏览器兜底。"""
    resp = _consume_into_session(token)
    if resp is None:
        return _invalid("这个链接已经用过了，或者超过 10 分钟没有打开。")
    return resp


@router.post("/api/enter", include_in_schema=False)
async def api_enter(request: Request) -> Response:
    """中转页调用的消费接口。成功后返回 {ok:true} 并种会话 cookie。

    用 POST + JS 触发而不是 GET：链接预览爬虫只发 GET、不执行 JS。
    """
    body: object = None
    try:
        body = await request.json()
    except JSONDecodeError:
        body = None
    token = str(body.get("token") or "") if isinstance(body, dict) else ""

    ticket = pool.consume(token)
    if ticket is None:
        return JSONResponse(
            {"ok": False, "error": "这个链接已经用过了，或者超过 10 分钟没有打开。"},
            headers=_NO_STORE_HEADERS,
        )

    sess = sessions.create(ticket.user_id, ticket.bot_id)
    logger.info(f"[ww工具箱] token 已消费 → 会话 {sess.sid[:8]}… ({ticket.user_id}@{ticket.bot_id})")
    resp = JSONResponse({"ok": True}, headers=_NO_STORE_HEADERS)
    _set_session_cookie(resp, sess.sid)
    return resp


@router.get("", include_in_schema=False)
@router.get("/", response_class=HTMLResponse, include_in_schema=False)
async def index(request: Request) -> Response:
    """主页面：Open Design 原型页 + 闭包内注入服务端适配器。

    没有会话就回失效页（不能直接给 UI，否则等于绕过鉴权）。
    """
    sess = _session_from(request)
    if sess is None:
        return _invalid("还没打开有效链接，或者这次会话已经过期了。")

    page = _STATIC / "index.html"
    if not page.exists():
        return HTMLResponse("<h1>工具箱资源缺失</h1>", status_code=500)

    html = page.read_text(encoding="utf-8")
    # 注入到闭包结尾的最后一段（init(); 之后可能有别的收尾调用，
    # 用 rfind 兜住结尾形态变化，避免锚点失配导致 adapter 静默不注入）
    tail = html.rfind("})();")
    adapter = _ADAPTER_JS.strip()
    if tail < 0:
        raise RuntimeError("index.html 缺少闭包结尾，adapter 无法注入")
    html = html[:tail] + adapter + chr(10) + html[tail:]
    resp = HTMLResponse(html, headers=_NO_STORE_HEADERS)
    # 续期：用户一直在用就顺延，避免改半天配队结果会话先到期
    return _set_session_cookie(resp, sess.sid)


# 注入进原型页 IIFE 内部的适配器：拉真实数据覆盖内联演示数据，存档落 DB
_ADAPTER_JS = """
  /* ==== wwtoolkit server adapter ==== */
  (async () => {
    let d = null;
    try {
      const r = await fetch('/waves/toolkit/api/bootstrap', { credentials: 'same-origin' });
      d = await r.json();
    } catch (e) { return; }
    if (!d || !d.ok) return;

    if (d.account) {
      ACCOUNT.uid = d.account.uid || ACCOUNT.uid;
      ACCOUNT.name = d.account.name || ACCOUNT.name;
      ACCOUNT.level = d.account.level || ACCOUNT.level;
      ACCOUNT.worldLevel = d.account.worldLevel || ACCOUNT.worldLevel;
      ACCOUNT.activeDays = d.account.activeDays || ACCOUNT.activeDays;
    }

    if (Array.isArray(d.characters) && d.characters.length) {
      const mapped = d.characters.map((c) => ({
        id: String(c.id),
        name: c.name,
        element: c.element || '',
        quality: c.quality || 5,
        stamina: c.stamina || 1,
        level: c.level || 1,
        chain: c.chain || 0,
        chain_name: c.chain_name || '',
        score: c.score || 0,
        score_bg: c.score_bg || 'c',
        weapon_reson: c.weapon_reson || 1,
        sonata: c.sonata || '',
        weapon: {
          id: String((c.weapon && c.weapon.id) || ''),
          name: (c.weapon && c.weapon.name) || '',
          star: (c.weapon && c.weapon.star) || 3,
          level: (c.weapon && c.weapon.level) || 0,
          breach: (c.weapon && c.weapon.breach) || 0,
        },
        skills: (c.skills || []).map((sk) => ({ name: String(sk.name || ''), level: sk.level || 0 })),
        modal: c.modal ? { list: c.modal.list || [], active: c.modal.active } : null,
      }));
      // 用户切过的模态（od_state.modals）覆盖面板默认激活分支
      const savedModals = (d.state && d.state.od_state && d.state.od_state.modals) || {};
      mapped.forEach((c) => {
        if (c.modal && savedModals[c.id] !== undefined) c.modal.active = savedModals[c.id];
      });
      CHARS.splice(0, CHARS.length, ...mapped);
      CHAR_MAP.clear();
      for (const c of CHARS) CHAR_MAP.set(String(c.id), c);
      for (const k of Object.keys(AVATAR)) delete AVATAR[k];
      for (const c of d.characters) {
        AVATAR[String(c.id)] = '/waves/toolkit/api/avatar/' + encodeURIComponent(String(c.id));
        if (c.weapon && c.weapon.id) {
          WEAPON_ICON[String(c.weapon.id)] = '/waves/toolkit/api/weapon/' + encodeURIComponent(String(c.weapon.id));
        }
      }
    }

    if (d.matrix && Array.isArray(d.matrix.rounds) && d.matrix.rounds.length) {
      // 名单以 wiki 当期为准：按 slot 顺序替换旧种子里的 boss 名，血条结构/分值不动
      const infoBosses = (d.matrix_info && Array.isArray(d.matrix_info.bosses)) ? d.matrix_info.bosses : [];
      const wikiNameBySlot = {};
      infoBosses.forEach((b, i) => { wikiNameBySlot[i + 1] = b.name; });
      const metaByWikiName = {};
      infoBosses.forEach((b) => { metaByWikiName[b.name] = b; });
      MATRIX_ROUNDS.splice(0, MATRIX_ROUNDS.length, ...d.matrix.rounds.map((r) => ({
        id: r.id,
        index: r.index,
        bosses: (r.bosses || []).map((b) => {
          const name = wikiNameBySlot[b.slot] || b.name;
          const meta = metaByWikiName[name] || {};
          return { slot: b.slot, code: b.code, name,
            isChest: !!b.isChest, base: b.base, extra: b.extra,
            icon: meta.icon || '', desc: meta.desc || [], tags: meta.tags || [] };
        }),
      })));
    }

    if (d.matrix_info) {
      const mi = d.matrix_info;
      MATRIX_INFO.period = mi.period || MATRIX_INFO.period;
      MATRIX_INFO.level_name = mi.level_name || MATRIX_INFO.level_name;
      MATRIX_INFO.buffs = (mi.buffs || []).map((b) => ({ name: b.name, desc: b.desc, icon: b.id ? '/waves/toolkit/api/monster/' + b.id : '', id: b.id || 0 }));
      MATRIX_INFO.bosses = (mi.bosses || []).map((b) => {
        const mon = String(b.icon || '').split('/').pop() || '';
        if (mon) MONSTER_IMG[mon] = b.icon;
        return { name: b.name, tags: b.tags || [], rounds: b.rounds || 3, desc: b.desc || [], mon };
      });
      MATRIX_INFO.roles = (mi.roles || []).map((r) => ({
        name: r.name, role_id: String(r.role_id || ''), desc: r.desc || '',
      }));
      MATRIX_INFO.stamina2_roles = mi.stamina2_roles || [];
    }

    const cloud = d.state && d.state.od_state;
    try {
      if (cloud && typeof cloud === 'object') {
        localStorage.setItem(LS_KEY, JSON.stringify(cloud));
      } else {
        localStorage.removeItem(LS_KEY);
      }
    } catch (e) { /* 忽略 */ }
    loadState();
    initHeader();
    renderPool();
    renderTeams();
    updateTabs();
    switchView(state.view);
    // 方案下拉需要在 presets 载入后同步一次（首次 init 时 presets 还是空）
    if (typeof syncTopSelects === 'function') syncTopSelects();
    // 打开页面即同步矩阵编队（静默，不弹确认框；失败不影响页面可用）
    if (typeof matrixAutoSync === 'function') {
      try { await matrixAutoSync(); } catch (e) { /* 同步失败不影响其它功能 */ }
    }

    let saveT = null;
    const postSave = () => {
      let payload = null;
      try { payload = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return; }
      if (!payload) return;
      fetch('/waves/toolkit/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ od_state: payload }),
      }).catch(() => {});
    };
    const origSaveNow = saveNow;
    saveNow = function () {
      origSaveNow();
      clearTimeout(saveT);
      saveT = setTimeout(postSave, 250);
    };
  })();
"""


@router.get("/static/{name:path}", include_in_schema=False)
async def static_file(name: str) -> Response:
    # 静态资源不含用户数据，且页面本身已由会话保护，这里不再要求会话
    # （否则浏览器缓存的旧页面会在会话过期后连 CSS 都加载不出来）
    target = (_STATIC / name).resolve()
    try:
        target.relative_to(_STATIC.resolve())
    except ValueError:
        raise HTTPException(status_code=404)
    if not target.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(target)


def _asset_version(path: Path) -> str:
    """用 mtime 当 cache buster，改完脚本不用手动清缓存。"""
    try:
        return str(int(path.stat().st_mtime))
    except OSError:
        return "0"


# ---------- 数据接口 ----------


@router.get("/api/bootstrap")
async def bootstrap(request: Request) -> JSONResponse:
    """页面加载时调用：返回账号信息 + XWUID 角色表 + 该用户存档。"""
    sess = _require_session(request)

    uid = await xwuid_bridge.resolve_uid(sess.user_id, sess.bot_id)
    if uid is None:
        return JSONResponse(
            {
                "ok": False,
                "need_bind": True,
                "error": "还没有绑定鸣潮特征码，先在群里发 ww绑定 你的UID",
            },
            headers=_NO_STORE_HEADERS,
        )

    # 先拿本期矩阵信息：「额外疲劳值」角色会变成 2 点体力，得在生成角色表之前知道
    matrix_info = matrix_info_mod.load_matrix_info()
    bonus_roles = matrix_info_mod.stamina_bonus_roles(matrix_info)
    # 登记本期怪物的官方头像地址，供 /api/monster/{id} 抓取
    _remember_monster_icons(matrix_info)

    characters = xwuid_data.load_characters(uid, stamina_bonus=bonus_roles)
    # 用官方评分接口补齐等级(c/b/a/s/ss/sss)、中文链名、精炼、声骸套装
    characters = await xwuid_data.enrich_with_ranks(uid, characters)
    if not characters:
        return JSONResponse(
            {
                "ok": False,
                "need_refresh": True,
                "uid": uid,
                "error": "还没有角色面板数据，先在群里发 ww刷新面板",
            },
            headers=_NO_STORE_HEADERS,
        )

    state = await db.WavesToolkitState.load(sess.user_id, sess.bot_id)
    return JSONResponse(
        {
            "ok": True,
            "user": {"uid": sess.user_id, "bot": sess.bot_id, "waves_uid": uid},
            "account": xwuid_data.load_account(uid),
            "characters": characters,
            "matrix": _read_json("matrix.json"),
            "matrix_info": _matrix_info_payload(matrix_info, bonus_roles),
            "state": state,
        },
        headers=_NO_STORE_HEADERS,
    )


def _matrix_info_payload(info, bonus_roles: set[str]) -> dict | None:
    """把本期矩阵信息压成前端好用的结构；没有数据时返回 None。"""
    if info is None:
        return None
    return {
        "period": info.period,
        "level_name": info.level_name,
        "buffs": [{"name": b.name, "desc": b.desc, "icon": b.icon, "id": b.buff_id} for b in info.buffs],
        "bosses": [
            {
                "name": b.name,
                "tags": [{"name": t, "color": c} for t, c in b.tags],
                "desc": list(b.desc),
                "unlocked": list(b.unlocked_note),
                "rounds": b.rounds,
                # 前端只拿这个相对地址，不直接碰外部 CDN
                "icon": f"/waves/toolkit/api/monster/{b.monster_id}" if b.monster_id else "",
            }
            for b in info.bosses
        ],
        "roles": [{"name": r.name, "role_id": r.role_id, "desc": r.desc} for r in info.roles],
        "stamina2_roles": sorted(bonus_roles),
    }


@router.post("/api/save")
async def save(request: Request) -> JSONResponse:
    """整包覆盖存档。前端防抖 320ms，会频繁调用。"""
    sess = _require_session(request)
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是对象")

    uid = await xwuid_bridge.resolve_uid(sess.user_id, sess.bot_id) or ""
    try:
        size = await db.WavesToolkitState.store(sess.user_id, sess.bot_id, payload, uid=uid)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc))
    return JSONResponse({"ok": True, "bytes": size}, headers=_NO_STORE_HEADERS)


@router.post("/api/reset")
async def reset(request: Request) -> JSONResponse:
    sess = _require_session(request)
    removed = await db.WavesToolkitState.clear(sess.user_id, sess.bot_id)
    return JSONResponse({"ok": True, "removed": removed}, headers=_NO_STORE_HEADERS)


@router.post("/api/logout")
async def logout(request: Request) -> Response:
    """主动退出：销毁会话，之后刷新会回到失效页。"""
    sid = request.cookies.get(COOKIE_NAME)
    if sid:
        sessions.destroy(sid)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/waves/toolkit")
    return resp


@router.get("/api/avatar/{role_id}")
async def avatar(role_id: int, request: Request) -> Response:
    """角色头像。走会话鉴权，避免把 XWUID 的资源目录直接暴露成静态站点。"""
    _require_session(request)
    path = xwuid_bridge.char_avatar_path(role_id)
    if path is None:
        raise HTTPException(status_code=404)
    media = "image/webp" if path.suffix == ".webp" else "image/png"
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=86400"})


_MONSTER_DIR = Path(__file__).parent / "data" / "monster_cache"

# 只允许抓这些 CDN，避免这个端点被当成任意 URL 代理
_MONSTER_HOSTS = ("static.nanoka.cc", "api-v2.encore.moe", "api.encore.moe")

# MonsterId -> 官方 Icon 直链，由 bootstrap 填充（前端只认 id，不接触外部域名）
_monster_icon_urls: dict[int, str] = {}


def _remember_monster_icons(info) -> None:
    """把本期怪物的官方头像地址记下来，供 /api/monster/{id} 使用。"""
    if info is None:
        return
    for boss in info.bosses:
        if boss.monster_id and boss.icon_url:
            _monster_icon_urls[boss.monster_id] = boss.icon_url
    # 本期 Buff 图标也走同一代理（Id 是小数字，不会与 9 位 MonsterId 冲突）
    for buff in info.buffs:
        if buff.buff_id and buff.icon:
            _monster_icon_urls[buff.buff_id] = buff.icon


@router.get("/api/monster/{monster_id}")
async def monster_icon(monster_id: int, request: Request) -> Response:
    """怪物头像：优先本地 XWUID 资源，没有就按官方 CDN 抓一次并落盘缓存。

    抓取放在服务端：既绕开浏览器跨域，也保证同一只 boss 只下载一次。
    """
    _require_session(request)

    local = xwuid_bridge.monster_icon_path(monster_id)
    if local is not None:
        return FileResponse(
            local, media_type="image/png", headers={"Cache-Control": "private, max-age=604800"}
        )

    cached = _MONSTER_DIR / f"monster_{monster_id}.webp"
    if cached.is_file():
        return FileResponse(
            cached, media_type="image/webp", headers={"Cache-Control": "private, max-age=604800"}
        )

    url = _monster_icon_urls.get(monster_id)
    if not url:
        raise HTTPException(status_code=404, detail="没有这只怪物的头像来源")

    from urllib.parse import urlsplit

    if urlsplit(url).hostname not in _MONSTER_HOSTS:
        raise HTTPException(status_code=400, detail="头像来源不在白名单")

    import httpx

    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            resp = await client.get(url, headers={"Referer": ""})
    except Exception as exc:
        logger.warning(f"[ww工具箱] 抓怪物头像 {monster_id} 失败：{exc}")
        raise HTTPException(status_code=502, detail="头像下载失败")
    if resp.status_code != 200 or not resp.content:
        raise HTTPException(status_code=502, detail="头像下载失败")

    _MONSTER_DIR.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(resp.content)
    return FileResponse(
        cached, media_type="image/webp", headers={"Cache-Control": "private, max-age=604800"}
    )


@router.get("/api/weapon/{weapon_id}")
async def weapon_icon(weapon_id: int, request: Request) -> Response:
    """武器图标：读 XWUID 本地 waves_weapon 资源。"""
    _require_session(request)
    path = xwuid_bridge.weapon_icon_path(weapon_id)
    if path is None:
        raise HTTPException(status_code=404)
    media = "image/webp" if path.suffix == ".webp" else "image/png"
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=604800"})


@router.get("/api/tex/{name}")
async def tex_asset(name: str, request: Request) -> Response:
    """XWUID charinfo 的静态小素材（白名单）。"""
    _require_session(request)
    fname = {"promote_icon": "promote_icon.png"}.get(name)
    if fname is None:
        raise HTTPException(status_code=404)
    path = xwuid_bridge.charinfo_tex_path(fname)
    if path is None:
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=604800"})


@router.get("/api/skill/{role_id}/{skill_name}")
async def skill_icon(role_id: str, skill_name: str, request: Request) -> Response:
    """技能图标：读 XWUID 的 RoleDetail/skill 缓存（练度统计/面板时下载）。"""
    _require_session(request)
    path = xwuid_bridge.skill_icon_path(role_id, skill_name)
    if path is None:
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=604800"})


@router.get("/api/modal/{name}")
async def modal_icon(name: str, request: Request) -> Response:
    """共鸣模态图标（按分支名取 XWUID 缓存）。"""
    _require_session(request)
    path = xwuid_bridge.modal_icon_path(name)
    if path is None:
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=604800"})




# ---------- 预设配队管理（密码登录） ----------
_ADMIN_COOKIE = "mc_toolkit_admin"
_ADMIN_TOKENS: set[str] = set()
_PRESET_DB_ID = "__global__"
_PRESET_DB_BOT = "__preset__"


def _admin_authed(request: Request) -> bool:
    tok = request.cookies.get(_ADMIN_COOKIE, "")
    return bool(tok) and tok in _ADMIN_TOKENS


async def _load_presets() -> list:
    data = await db.WavesToolkitState.load(user_id=_PRESET_DB_ID, bot_id=_PRESET_DB_BOT)
    v = data.get("mc_presets")
    return v if isinstance(v, list) else []


@router.get("/api/admin/state")
async def admin_state(request: Request) -> Response:
    _require_session(request)
    return JSONResponse({"authed": _admin_authed(request), "enabled": bool(config.admin_password())})


@router.post("/api/admin/login")
async def admin_login(request: Request) -> Response:
    _require_session(request)
    pwd = config.admin_password()
    if not pwd:
        raise HTTPException(status_code=403, detail="管理页未启用：请在控制台配置预设管理密码")
    body = await request.json()
    password = str(body.get("password") or "")
    if password != pwd:
        raise HTTPException(status_code=401, detail="密码错误")
    token = secrets.token_urlsafe(24)
    _ADMIN_TOKENS.add(token)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        _ADMIN_COOKIE, token, max_age=12 * 3600, httponly=True, samesite="lax", path="/waves/toolkit"
    )
    return resp


@router.post("/api/admin/logout")
async def admin_logout(request: Request) -> Response:
    _ADMIN_TOKENS.discard(request.cookies.get(_ADMIN_COOKIE, ""))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(_ADMIN_COOKIE, path="/waves/toolkit")
    return resp


@router.get("/api/presets")
async def presets_get(request: Request) -> Response:
    """预设清单：登录会话内的用户都可读（用于一键填充）。"""
    _require_session(request)
    return JSONResponse({"presets": await _load_presets()})


@router.post("/api/presets")
async def presets_save(request: Request) -> Response:
    """整份覆盖保存预设清单，仅管理员。"""
    _require_session(request)
    if not _admin_authed(request):
        raise HTTPException(status_code=403, detail="需要管理员登录")
    body = await request.json()
    presets = body.get("presets") if isinstance(body, dict) else None
    if not isinstance(presets, list):
        raise HTTPException(status_code=400, detail="presets 必须是列表")
    clean: list[dict] = []
    for item in presets[:100]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:24]
        members_raw = item.get("members")
        members = [str(m) for m in members_raw][:3] if isinstance(members_raw, list) else []
        if not name or not members:
            continue
        clean.append(
            {
                "id": str(item.get("id") or secrets.token_urlsafe(6)),
                "name": name,
                "members": members,
                "source": str(item.get("source") or "").strip()[:40],
                "note": str(item.get("note") or "").strip()[:60],
            }
        )
    size = await db.WavesToolkitState.store(
        user_id=_PRESET_DB_ID, bot_id=_PRESET_DB_BOT, payload={"mc_presets": clean}
    )
    return JSONResponse({"ok": True, "count": len(clean), "size": size})


@router.get("/api/allchars")
async def allchars(request: Request) -> Response:
    """全角色表（含未拥有角色），管理页选角用。"""
    _require_session(request)
    return JSONResponse({"characters": xwuid_bridge.all_characters()})


@router.get("/api/roster_avatar/{role_id}")
async def roster_avatar(role_id: str, request: Request) -> Response:
    _require_session(request)
    path = xwuid_bridge.roster_avatar_path(role_id)
    if path is None:
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=604800"})


@router.get("/api/head_avatar/{role_id}")
async def head_avatar(role_id: str, request: Request) -> Response:
    _require_session(request)
    path = xwuid_bridge.head_avatar_path(role_id)
    if path is None:
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=604800"})


@router.get("/api/matrix_teams")
async def matrix_teams(request: Request) -> Response:
    """账号已打的终焉矩阵编队（游戏内实际使用的队伍），供一键带入。"""
    sess = _require_session(request)
    uid = await xwuid_bridge.resolve_uid(sess.user_id, sess.bot_id)
    if not uid:
        raise HTTPException(status_code=400, detail="还没有绑定鸣潮 UID")
    is_self, ck = await xwuid_bridge.cookie_of(uid, sess.user_id, sess.bot_id)
    if not ck:
        raise HTTPException(status_code=400, detail="没有可用的库街区凭证，请先 ww登录")
    waves_api = xwuid_bridge._waves_module("utils.waves_api").waves_api
    try:
        res = await waves_api.get_matrix_detail(uid, ck)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"矩阵接口请求失败：{exc}")
    if not res.success:
        raise HTTPException(status_code=502, detail=res.throw_msg() or "矩阵数据获取失败")
    data = res.data
    if not data or (isinstance(data, dict) and not data.get("isUnlock")):
        raise HTTPException(status_code=404, detail="当前暂无终焉矩阵数据")
    modes = data.get("modeDetails") or []
    # 优先奇点扩张（modeId=1），没有已打记录就退回稳态协议
    mode = next((m for m in modes if m.get("modeId") == 1 and (m.get("teams") or [])), None)
    if mode is None:
        mode = next((m for m in modes if m.get("teams") or []), None)
    if mode is None:
        raise HTTPException(status_code=404, detail="本期还没有已打的矩阵队伍")
    teams: list[dict] = []
    for t in mode.get("teams") or []:
        roles = [str(r.get("roleId")) for r in (t.get("roleList") or []) if r.get("roleId")]
        if not roles:
            continue
        buff_ids = [int(b.get("buffId") or 0) for b in (t.get("buffs") or []) if b.get("buffId")]
        teams.append(
            {
                "members": roles,
                "score": int(t.get("score") or 0),
                "round": int(t.get("round") or 0),
                "buffs": buff_ids,
            }
        )
    # 保持游戏内返回的顺序（第1轮 5 队 → 第2轮 6 队 → 第3轮 …）。
    # 这里曾经按分数降序排过，导致同步后配队顺序与矩阵里看到的完全不一致；
    # 用户要的是「照矩阵原样铺」，所以不做任何重排。
    mode_name = "奇点扩张" if mode.get("modeId") == 1 else "稳态协议"
    return JSONResponse({"modeName": mode_name, "teams": teams})


@router.get("/api/health")
async def health() -> JSONResponse:
    """无鉴权探活：部署后用来确认路由挂上了。"""
    return JSONResponse({"ok": True, "static": _STATIC.is_dir(), "pending": pool.size()})


@router.post("/api/_dev_capture")
async def dev_capture(request: Request) -> JSONResponse:
    """调试用：在本进程内跑指定 XWUID handler，截获出站图片存盘。

    用途：生成风格参考图（角色面板/练度统计/矩阵记录）。需要 DB 的 handler
    必须在运行中的 core 进程里执行，独立脚本拿不到数据库会话。
    门槛与 _dev_ticket 相同：控制台 ToolkitDevTicket=True + 仅回环。
    """
    from .config import dev_ticket_enabled

    if not dev_ticket_enabled():
        raise HTTPException(status_code=403, detail="调试端点未开启")
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="仅允许本机调用")

    body = await request.json()
    module_name = str(body.get("module") or "")
    func_name = str(body.get("func") or "")
    text = str(body.get("text") or "")
    user_id = str(body.get("user_id") or "70002")
    regex_dict = body.get("regex_dict") or {}
    out_dir = str(body.get("out_dir") or "D:/tmp/xwuid-refs")
    if not module_name or not func_name:
        raise HTTPException(status_code=400, detail="需要 module 和 func")

    import importlib
    import pathlib as _pl

    from gsuid_core.ai_core.command_aside import capture
    from gsuid_core.models import Event

    mod = importlib.import_module(
        f"plugins.XutheringWavesUID.XutheringWavesUID.{module_name}"
    )
    handler = getattr(mod, func_name, None)
    if handler is None:
        raise HTTPException(status_code=404, detail=f"handler 不存在: {func_name}")

    ev = Event(
        user_id=user_id,
        bot_id="qq",
        bot_self_id="10000",
        user_type="group",
        group_id="9",
        raw_text=text,
        command=text,
        text=text,
    )
    if regex_dict:
        ev.regex_dict = dict(regex_dict)

    saved: list[str] = []
    texts: list[str] = []

    class _StubBot:
        async def send(self, msg, *a, **kw):
            await capture.capture_outbound(msg)
            return None

        async def send_option(self, msg, *a, **kw):
            await capture.capture_outbound(msg)
            return None

    out = _pl.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    token = capture.begin_capture()
    err = ""
    try:
        await handler(_StubBot(), ev)
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
    pieces = capture.end_capture(token)

    idx = 0
    for pc in pieces:
        if pc.kind == "image" and pc.image:
            target = out / f"{func_name}_{idx}.png"
            target.write_bytes(pc.image)
            saved.append(str(target))
            idx += 1
        elif pc.kind == "text" and pc.text.strip():
            texts.append(pc.text[:200])

    return JSONResponse({"ok": True, "saved": saved, "texts": texts, "error": err})


@router.post("/api/_dev_ticket")
async def dev_ticket(request: Request) -> JSONResponse:
    """调试用：直接签发一个一次性链接，免去在群里发指令。

    只有同时满足以下条件才可用：
    - 控制台配置 ToolkitDevTicket=True；
    - 请求来自回环地址（127.0.0.1 / ::1）。
    正式环境保持关闭，避免成为「绕过 QQ 身份」的口子。
    """
    from .config import dev_ticket_enabled

    if not dev_ticket_enabled():
        raise HTTPException(status_code=403, detail="调试签发未开启")
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="仅允许本机调用")

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    if not isinstance(body, dict):
        body = {}
    user_id = str(body.get("user_id") or "debug-user")
    bot_id = str(body.get("bot_id") or "qq")

    # want_long=1 时发长效链接（可反复访问，7 天），否则发一次性 ticket
    if body.get("want_long"):
        key = long_links.issue(user_id=user_id, bot_id=bot_id, session_id="debug")
        return JSONResponse(
            {
                "ok": True,
                "url": f"/waves/toolkit/long/{key}",
                "user_id": user_id,
                "long": True,
                "days": 7,
            }
        )

    token = pool.issue(user_id=user_id, bot_id=bot_id, session_id="debug")
    return JSONResponse({"ok": True, "url": f"/waves/toolkit/{token}", "user_id": user_id})
