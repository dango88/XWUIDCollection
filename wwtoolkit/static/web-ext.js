/* =========================================================================
 * 鸣潮矩阵配队 · 网页版扩展
 * 由 wwtoolkit 后端在页面 </body> 前注入。
 *
 * 职责：把桌面版 desktop.js 里「纯前端可做」的那部分（存储桥、主C优先级面板、
 * 星级描边、拖拽排序）移植过来，去掉 pywebview 专属能力（文件对话框、截图识别、
 * 剪贴板、自动更新）。
 *
 * 与桌面版的差异：
 * - 存储走 HTTP（/waves/toolkit/api/save），不是本地 store.json；
 * - 没有截图识别，练度角标只在导入存档后可见；
 * - 导出文件走浏览器下载（Blob），不是另存为对话框。
 * ========================================================================= */
(function () {
  "use strict";

  var API_BASE = "/waves/toolkit/api";


  /* ---------- 会话 ---------- */
  /* 鉴权靠 HttpOnly 会话 cookie（后端种），前端拿不到也不需要拿。
     这里只负责：把「会话过期」翻译成人话提示，并阻止无意义的请求风暴。 */
  var sessionDead = false;

  function authHeaders(extra) {
    return extra || {};
  }

  function api(path, options) {
    var opt = options || {};
    if (sessionDead) {
      return Promise.reject(new Error("会话已过期，请回群里重新发送 ww配队"));
    }
    return fetch(API_BASE + path, {
      method: opt.method || "GET",
      headers: authHeaders(opt.body ? { "Content-Type": "application/json" } : {}),
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      credentials: "same-origin",
    }).then(function (res) {
      if (res.status === 401) sessionDead = true;
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var msg = (data && data.detail) || ("请求失败 (" + res.status + ")");
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------- toast（尽早可用，桥接失败时也能提示） ---------- */
  function toast(msg, kind) {
    var box = document.getElementById("toasts");
    if (!box) { console.log("[toolkit]", msg); return; }
    var div = document.createElement("div");
    div.className = "toast " + (kind || "");
    div.textContent = msg;
    box.appendChild(div);
    setTimeout(function () { div.classList.add("out"); }, 2600);
    setTimeout(function () { div.remove(); }, 3200);
  }

  /* ---------- 存档桥 ---------- */
  var deskStore = window.__MC_DESKTOP_STORE__ || (window.__MC_DESKTOP_STORE__ = {});
  // 原有 13 个键：与 desktop.js 的 LS_KEYS 保持一致
  var LS_KEYS = ["mc_characters", "mc_rules", "mc_presets", "mc_snapshots", "mc_current",
                 "mc_seed_seen", "mc_ui_flags", "mc_team_done", "mc_matrix", "mc_team_names",
                 "mc_config_scores", "mc_rule_mainc_priority", "mc_rule_mainc_rule_order"];

  var saveTimer = null;
  var saving = false;
  var pending = false;
  var lastSaveOk = null;

  function collect() {
    var out = {};
    for (var i = 0; i < LS_KEYS.length; i++) {
      var k = LS_KEYS[i];
      if (!Object.prototype.hasOwnProperty.call(deskStore, k)) continue;
      var v = deskStore[k];
      // 角色表里的头像是 base64 大图，后端有 /api/avatar 按 roleId 现取，
      // 没必要每次都回传（实测 3 人就几百 KB，几十人会上 MB）
      if (k === "mc_characters" && Array.isArray(v)) {
        v = v.map(function (c) {
          if (!c || typeof c !== "object") return c;
          var copy = {};
          Object.keys(c).forEach(function (f) { if (f !== "avatar") copy[f] = c[f]; });
          return copy;
        });
      }
      out[k] = v;
    }
    return out;
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (sessionDead) return Promise.resolve(false);

    if (saving) { pending = true; return Promise.resolve(false); }
    saving = true;

    return api("/save", { method: "POST", body: collect() }).then(function (r) {
      lastSaveOk = !!(r && r.ok);
      updateSaveState();
      return lastSaveOk;
    }).catch(function (err) {
      lastSaveOk = false;
      updateSaveState(err);
      return false;
    }).then(function (ok) {
      saving = false;
      if (pending) { pending = false; return flushSave(); }
      return ok;
    });
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 320);
  }

  window.__MC_DESKTOP_WRITE__ = function (key, value) {
    deskStore[key] = value;
    scheduleSave();
  };

  window.__MC_DESKTOP_SAVE__ = function (filename, text, mime) {
    // 浏览器里直接走原生下载，不接管
    return false;
  };

  /* 保存状态指示灯（页面没有就静默跳过） */
  function updateSaveState(err) {
    var el = document.getElementById("mcSaveState");
    if (!el) return;
    if (lastSaveOk === null) { el.textContent = ""; return; }
    if (lastSaveOk) {
      el.textContent = "已保存";
      el.style.color = "var(--ok)";
    } else {
      el.textContent = "保存失败" + (err && err.message ? "：" + err.message : "");
      el.style.color = "var(--danger)";
    }
  }

  /* ---------- 小工具 ---------- */
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "className") node.className = attrs[k];
        else if (k === "style") node.style.cssText = attrs[k];
        else if (k.indexOf("data-") === 0 || k === "title" || k === "id") node.setAttribute(k, attrs[k]);
        else node[k] = attrs[k];
      });
    }
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function safeToast(msg, kind) {
    try { toast(msg, kind); } catch (e) { console.log(msg); }
  }

  /* ---------- 角色表 / 星级 ---------- */
  var NON_5_NAMES = { "卡卡罗": 1, "凌阳": 1, "安可": 1, "鉴心": 1, "维里奈": 1 };
  var REFINE_ALWAYS = { "主角": 1 };
  var QUALITY = {};
  if (typeof ROSTER !== "undefined" && ROSTER) {
    ROSTER.forEach(function (r) { QUALITY[r[0]] = NON_5_NAMES[r[0]] ? 4 : r[3]; });
  }

  var configScores = (deskStore.mc_config_scores && typeof deskStore.mc_config_scores === "object")
    ? deskStore.mc_config_scores : {};
  var teamNames = (deskStore.mc_team_names && typeof deskStore.mc_team_names === "object")
    ? deskStore.mc_team_names : {};
  var maincPriority = Array.isArray(deskStore.mc_rule_mainc_priority)
    ? deskStore.mc_rule_mainc_priority.filter(function (x) { return typeof x === "string"; }) : [];
  var maincRuleOrder = (deskStore.mc_rule_mainc_rule_order && typeof deskStore.mc_rule_mainc_rule_order === "object")
    ? deskStore.mc_rule_mainc_rule_order : {};
  var selectedMainc = "";
  /* 后端给的权威角色表（XWUID 面板）。渲染前会被钉进 state.characters。 */
  var mergedChars = [];

  /** 把 XWUID 的练度（共鸣链/评分）灌进 configScores，供角标与彩框使用。 */
  function rebuildConfigScores(serverChars) {
    var next = {};
    serverChars.forEach(function (c) {
      if (c.chain === null && c.score === null) return;
      next[String(c.id)] = {
        chain: typeof c.chain === "number" ? c.chain : null,
        score: typeof c.score === "number" ? c.score : null,
      };
    });
    configScores = next;
    deskStore.mc_config_scores = next;
    scheduleSave();
  }

  /** 数据没准备好时整页挡住，给出明确的下一步指令。 */
  function showBlocking(message) {
    var box = document.createElement("div");
    box.id = "mcBlocking";
    box.innerHTML =
      '<div style="position:fixed;inset:0;background:#0e1116;z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;padding:24px">' +
      '<div style="max-width:480px;text-align:center;border:1px solid #30363d;' +
      'border-radius:12px;background:#161b22;padding:32px">' +
      '<h2 style="margin:0 0 12px;font-size:17px;color:#d29922">还不能开始配队</h2>' +
      '<p style="color:#8b949e;font-size:13px;line-height:1.8;margin:0 0 16px"></p>' +
      '<button class="btn primary sm" id="mcBlockingRetry">我已处理，重新加载</button>' +
      "</div></div>";
    box.querySelector("p").textContent = message;
    document.body.appendChild(box);
    box.querySelector("#mcBlockingRetry").addEventListener("click", function () {
      window.location.reload();
    });
  }

  function charById(id) {
    if (typeof state === "undefined" || !state.characters) return null;
    for (var i = 0; i < state.characters.length; i++) {
      if (state.characters[i].id === id) return state.characters[i];
    }
    return null;
  }
  function charByName(name) {
    if (typeof state === "undefined" || !state.characters) return null;
    for (var i = 0; i < state.characters.length; i++) {
      if (state.characters[i].name === name) return state.characters[i];
    }
    return null;
  }
  function ruleKey(rule) {
    return (rule && rule.members ? rule.members.slice() : []).sort().join("|");
  }
  function ruleMaincName(rule) {
    var members = (rule && rule.members) || [];
    for (var i = 0; i < members.length; i++) {
      var c = charById(members[i]);
      if (c) return c.name;
    }
    return "";
  }
  function categoriesRuleKeys(name) {
    var keys = [], seen = {};
    ((typeof state !== "undefined" && state.rules) || []).forEach(function (r) {
      if (ruleMaincName(r) !== name) return;
      var k = ruleKey(r);
      if (!seen[k]) { seen[k] = true; keys.push(k); }
    });
    return keys;
  }

  /* ---------- 主C优先级（移植自 desktop.js） ---------- */
  function persistMaincPriority() {
    deskStore.mc_rule_mainc_priority = maincPriority.slice();
    scheduleSave();
    flushSave();
  }

  function persistMaincRuleOrder() {
    deskStore.mc_rule_mainc_rule_order = maincRuleOrder;
    var p = flushSave();
    return p;
  }

  function normalizeMaincPriority() {
    var seen = {}, defaults = [];
    ((typeof state !== "undefined" && state.rules) || []).forEach(function (r) {
      var n = ruleMaincName(r);
      if (n && !seen[n]) { seen[n] = true; defaults.push(n); }
    });
    var valid = {}, next = [];
    defaults.forEach(function (n) { valid[n] = true; });
    maincPriority.forEach(function (n) {
      if (valid[n] && next.indexOf(n) < 0) next.push(n);
    });
    defaults.forEach(function (n) { if (next.indexOf(n) < 0) next.push(n); });
    var changed = JSON.stringify(next) !== JSON.stringify(maincPriority);
    maincPriority = next;
    if (changed) persistMaincPriority();
    return maincPriority;
  }

  function normalizeMaincRuleOrder() {
    var next = {}, changed = false;
    // 规则还没加载完时绝不能归一化，否则会把顺序写空并存回去
    if (!((typeof state !== "undefined" && state.rules) || []).length) return maincRuleOrder;
    maincPriority.forEach(function (name) {
      var keys = categoriesRuleKeys(name);
      var old = Array.isArray(maincRuleOrder[name]) ? maincRuleOrder[name] : [];
      var out = old.filter(function (k) { return keys.indexOf(k) >= 0; });
      keys.forEach(function (k) { if (out.indexOf(k) < 0) out.push(k); });
      next[name] = out;
      if (JSON.stringify(out) !== JSON.stringify(old)) changed = true;
    });
    if (JSON.stringify(Object.keys(next)) !== JSON.stringify(Object.keys(maincRuleOrder))) changed = true;
    maincRuleOrder = next;
    if (changed) persistMaincRuleOrder();
    return maincRuleOrder;
  }

  function ruleOrderIndex(rule) {
    var name = ruleMaincName(rule), key = ruleKey(rule);
    var arr = (maincRuleOrder[name] || categoriesRuleKeys(name));
    var i = arr.indexOf(key);
    return i < 0 ? 9999 : i;
  }

  window.__MC_MAINC_PRIORITY__ = function () { return normalizeMaincPriority().slice(); };
  window.__MC_MAINC_OF_RULE__ = ruleMaincName;
  window.__MC_MAINC_RULE_ORDER__ = function () { return JSON.parse(JSON.stringify(normalizeMaincRuleOrder())); };
  window.__MC_RULE_ORDER_INDEX__ = ruleOrderIndex;

  /* ---------- 通用拖拽排序（移植自 desktop.js attachDragSort） ---------- */
  function attachDragSort(container, itemSelector, onDrop) {
    if (!container) return;
    Array.prototype.slice.call(container.querySelectorAll(itemSelector)).forEach(function (row) {
      if (row._mcDragSortBound) return;
      row._mcDragSortBound = true;

      row.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        if (e.target.closest("input,button,textarea,a")) return;

        var startX = e.clientX, startY = e.clientY;
        var rowRect = row.getBoundingClientRect();
        var offsetX = e.clientX - rowRect.left;
        var offsetY = e.clientY - rowRect.top;
        var lastX = e.clientX, lastY = e.clientY;

        // 落点判定用「按下那一刻」的布局快照：拖拽中 placeholder 会挤动网格
        var snap = Array.prototype.slice.call(container.querySelectorAll(itemSelector));
        var scroll0 = window.scrollY || 0;
        var scrollTop0 = container.scrollTop || 0;
        snap.forEach(function (it) {
          var r = it.getBoundingClientRect();
          it._mcCx = r.left + r.width / 2;
          it._mcCy = r.top + r.height / 2;
          it._mcTop = r.top;
          it._mcH = r.height;
        });

        var pointerId = e.pointerId;
        var started = false, ghost = null, placeholder = null;

        function items() {
          return Array.prototype.slice.call(container.querySelectorAll(itemSelector))
            .filter(function (x) { return x !== row; });
        }
        function movePlaceholder(x, y) {
          var list = items();
          var best = null, bestDist = Infinity, before = true;
          list.forEach(function (it) {
            var r = it.getBoundingClientRect();
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var dist = Math.hypot(x - cx, y - cy);
            if (dist < bestDist) {
              bestDist = dist; best = it;
              if (y < r.top + r.height * 0.35) before = true;
              else if (y > r.bottom - r.height * 0.35) before = false;
              else before = x < cx;
            }
          });
          var oldPos = list.map(function (it) { return [it, it.offsetLeft, it.offsetTop]; });
          if (best) {
            if (before) container.insertBefore(placeholder, best);
            else container.insertBefore(placeholder, best.nextSibling);
          } else {
            container.appendChild(placeholder);
          }
          oldPos.forEach(function (pair) {
            var it = pair[0], ox = pair[1], oy = pair[2];
            var dx = ox - it.offsetLeft, dy = oy - it.offsetTop;
            if (!dx && !dy) return;
            it.style.transition = "none";
            it.style.transform = "translate(" + dx + "px," + dy + "px)";
            requestAnimationFrame(function () {
              it.style.transition = "transform .16s ease";
              it.style.transform = "";
              setTimeout(function () { it.style.transition = ""; }, 180);
            });
          });
        }
        function onMove(ev) {
          if (ev.pointerId !== pointerId) return;
          if (!started && Math.abs(ev.clientY - startY) < 4 && Math.abs(ev.clientX - startX) < 4) return;
          if (!started) {
            started = true;
            row._mcSuppressClick = true;
            setTimeout(function () { row._mcSuppressClick = false; }, 0);
            placeholder = el("div", { className: "mc-sort-placeholder" });
            placeholder.style.height = rowRect.height + "px";
            placeholder.style.width = rowRect.width + "px";
            container.insertBefore(placeholder, row);
            row.style.display = "none";
            ghost = row.cloneNode(true);
            ghost.classList.add("mc-drag-ghost");
            ghost.style.width = rowRect.width + "px";
            ghost.style.height = rowRect.height + "px";
            ghost.style.left = rowRect.left + "px";
            ghost.style.top = rowRect.top + "px";
            ghost.style.display = "flex";
            document.body.appendChild(ghost);
            document.body.classList.add("mc-drag-sorting");
          }
          ev.preventDefault();
          lastX = ev.clientX;
          lastY = ev.clientY;
          ghost.style.left = (ev.clientX - offsetX) + "px";
          ghost.style.top = (ev.clientY - offsetY) + "px";
          movePlaceholder(ev.clientX, ev.clientY);
          if (ev.clientY < 80) window.scrollBy(0, -10);
          else if (ev.clientY > window.innerHeight - 80) window.scrollBy(0, 10);
        }
        function finish(ev) {
          if (ev && ev.pointerId !== pointerId) return;
          document.removeEventListener("pointermove", onMove, true);
          document.removeEventListener("pointerup", finish, true);
          document.removeEventListener("pointercancel", finish, true);
          if (!started) return;
          row.style.display = "";

          // 双列布局按 x 判左右；单列布局必须纯用 y 判前后，否则永远"插到前面"
          var multiCol = false;
          for (var a1 = 0; a1 < snap.length && !multiCol; a1++) {
            if (snap[a1] === row) continue;
            for (var b1 = a1 + 1; b1 < snap.length; b1++) {
              if (snap[b1] === row) continue;
              if (Math.abs(snap[a1]._mcTop - snap[b1]._mcTop) < 4) { multiCol = true; break; }
            }
          }
          var refEl = null, refAfter = false, bestDist = Infinity;
          for (var si = 0; si < snap.length; si++) {
            var it = snap[si];
            if (it === row || !it.parentNode) continue;
            var cx = it._mcCx;
            var cy = it._mcCy - ((window.scrollY || 0) - scroll0) - ((container.scrollTop || 0) - scrollTop0);
            if (typeof cx !== "number" || typeof cy !== "number") continue;
            var d = Math.sqrt((lastX - cx) * (lastX - cx) + (lastY - cy) * (lastY - cy));
            if (d < bestDist) {
              bestDist = d;
              refEl = it;
              var dh = (it._mcH || 40) * 0.5;
              if (multiCol && Math.abs(lastY - cy) <= dh) refAfter = lastX > cx;
              else refAfter = lastY >= cy;
            }
          }
          if (placeholder && placeholder.parentNode) placeholder.remove();
          if (refEl && refEl.parentNode === container) {
            container.insertBefore(row, refAfter ? refEl.nextSibling : refEl);
          } else if (row.parentNode === container) {
            container.appendChild(row);
          }
          if (ghost) ghost.remove();
          document.body.classList.remove("mc-drag-sorting");

          var keys = Array.prototype.slice.call(container.querySelectorAll(itemSelector))
            .map(function (r) { return r.getAttribute("data-key"); }).filter(Boolean);
          onDrop(keys);
        }
        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("pointerup", finish, true);
        document.addEventListener("pointercancel", finish, true);
      });
    });
  }

  /* ---------- 主C优先级面板渲染 ---------- */
  function renderMaincRules() {
    var box = document.getElementById("mcMaincRules");
    var title = document.getElementById("mcMaincRulesTitle");
    if (!box) return;
    normalizeMaincRuleOrder();
    if (!maincPriority.length) {
      box.innerHTML = "";
      if (title) title.textContent = "主C规则优先级";
      return;
    }
    if (maincPriority.indexOf(selectedMainc) < 0) selectedMainc = maincPriority[0];
    if (title) title.textContent = "「" + selectedMainc + "」的规则优先级";
    box.innerHTML = "";

    var rules = ((typeof state !== "undefined" && state.rules) || []).filter(function (r) {
      return ruleMaincName(r) === selectedMainc;
    });
    var order = maincRuleOrder[selectedMainc] || [];
    rules.sort(function (a, b) { return order.indexOf(ruleKey(a)) - order.indexOf(ruleKey(b)); });
    if (!rules.length) {
      box.appendChild(el("div", { className: "empty" }, "这个主C暂时没有规则。"));
      return;
    }
    rules.forEach(function (rule) {
      var key = ruleKey(rule);
      var row = el("div", { className: "mc-mainc-rule" + (rule.enabled ? "" : " off"), "data-key": key });
      row.appendChild(el("span", { className: "drag", title: "拖动调整该主C内规则优先级" }, "⋮"));
      var avs = el("span", { className: "mc-rule-avs" });
      (rule.members || []).forEach(function (id) {
        var c = charById(id);
        if (c && c.avatar) {
          var im = el("img", { src: c.avatar, alt: "", draggable: "false" });
          avs.appendChild(im);
        }
      });
      row.appendChild(avs);
      var names = (rule.members || []).map(function (id) {
        var c = charById(id);
        return c ? c.name : "已失效";
      }).join(" + ");
      row.appendChild(el("span", { className: "mc-rule-names", title: names }, names));
      row.appendChild(el("span", { className: "mc-rule-state" }, rule.enabled ? "启用" : "停用"));
      box.appendChild(row);
    });

    attachDragSort(box, ".mc-mainc-rule", function (keys) {
      var prev = maincRuleOrder[selectedMainc] || [];
      if (JSON.stringify(keys) === JSON.stringify(prev)) return;
      maincRuleOrder[selectedMainc] = keys;
      var pr = persistMaincRuleOrder();
      renderMaincRules();
      var name = selectedMainc;
      Promise.resolve(pr).then(function (ok) {
        if (ok === false) safeToast("「" + name + "」的规则顺序保存失败，请重试", "error");
        else safeToast("「" + name + "」的规则顺序已保存", "info");
      });
    });
  }

  function renderRulePriority() {
    var grid = document.getElementById("mcMaincPriority");
    if (!grid) return;
    normalizeMaincPriority();
    normalizeMaincRuleOrder();
    grid.innerHTML = "";

    if (!maincPriority.length) {
      grid.appendChild(el("div", { className: "empty", style: "grid-column:1/-1" }, "还没有可分类的绑定规则。"));
      renderMaincRules();
      return;
    }
    if (maincPriority.indexOf(selectedMainc) < 0) selectedMainc = maincPriority[0];

    maincPriority.forEach(function (name, idx) {
      var c = charByName(name) || null;
      var count = ((typeof state !== "undefined" && state.rules) || []).filter(function (r) {
        return ruleMaincName(r) === name;
      }).length;
      var row = el("div", {
        className: "mc-mainc-row" + (name === selectedMainc ? " selected" : ""),
        "data-key": name,
      });
      row.appendChild(el("span", { className: "mc-mainc-drag", title: "拖动调整主C优先级" }, "⋮"));
      row.appendChild(el("span", { className: "mc-mainc-idx" }, String(idx + 1)));
      var av = el("span", { className: "mc-mainc-av" });
      if (c && c.avatar) av.appendChild(el("img", { src: c.avatar, alt: "", draggable: "false" }));
      else av.appendChild(el("span", { className: "initial" }, (name || "?").charAt(0)));
      row.appendChild(av);
      row.appendChild(el("span", { className: "mc-mainc-name", title: name }, name));
      row.appendChild(el("span", { className: "mc-mainc-count" }, count + "条"));
      row.addEventListener("click", function () {
        if (row._mcSuppressClick) return;
        selectedMainc = name;
        renderRulePriority();
      });
      grid.appendChild(row);
    });

    attachDragSort(grid, ".mc-mainc-row", function (keys) {
      if (keys.length !== maincPriority.length) {
        safeToast("拖拽没生效（行列数对不上），请再拖一次", "warn");
        return;
      }
      if (JSON.stringify(keys) === JSON.stringify(maincPriority)) return;
      maincPriority = keys;
      persistMaincPriority();
      renderRulePriority();
      safeToast("主C优先级已保存", "info");
    });

    renderMaincRules();
  }
  window.__MC_RENDER_RULE_PRIORITY__ = renderRulePriority;

  /* ---------- 星级 / 练度框 ---------- */
  function frameRankOf(c) {
    var q = QUALITY[c.name];
    if (q !== 5) return 3;
    var data = configScores[c.id];
    if (!data) return 2;
    var chain = data.chain !== null && data.chain !== undefined ? Number(data.chain) : null;
    var score = data.score !== null && data.score !== undefined ? Number(data.score) : null;
    var isS = score !== null && isFinite(score) && score >= 175;
    var rainbow = chain !== null && isFinite(chain) && (chain >= 6 || (chain >= 2 && chain <= 6 && isS));
    if (rainbow) return 0;
    var red = chain !== null && isFinite(chain) && ((chain === 2 || chain === 3) || (chain === 0 && isS));
    return red ? 1 : 2;
  }
  window.__MC_FRAME_RANK__ = frameRankOf;
  window.__MC_HAS_CONFIG__ = function () { return Object.keys(configScores).length > 0; };

  function scoreRank(v) {
    v = Number(v);
    if (!isFinite(v)) return null;
    if (v >= 175) return { text: "S", cls: "rank-s" };
    if (v >= 150) return { text: "A", cls: "rank-a" };
    if (v >= 120) return { text: "B", cls: "rank-b" };
    return { text: "C", cls: "rank-c" };
  }

  /** 评分等级 → 配色。与 XWUID `ww角色列表` 的 score_bg 一一对应。 */
  var SCORE_BG_STYLE = {
    sss: { fg: "#ff8fd1", label: "SSS" },
    ss:  { fg: "#ffb86c", label: "SS"  },
    s:   { fg: "#ffd12f", label: "S"   },
    a:   { fg: "#7ee787", label: "A"   },
    b:   { fg: "#58a6ff", label: "B"   },
    c:   { fg: "#8b949e", label: "C"   },
  };

  /** 角色卡上的练度块：等级 + 分数 + 链/精炼。
   *  只在有实测数据的角色上出现，没识别过的角色保持卡片干净。 */
  window.__MC_CONFIG_BADGE__ = function (c) {
    if (!c) return "";
    var bg = String(c.scoreBg || "").toLowerCase();
    var style = SCORE_BG_STYLE[bg];
    var score = typeof c.score === "number" ? c.score : null;
    var chainName = c.chainName || "";
    var reson = c.weaponReson || 0;

    // 什么都没有就不加块
    if (!style && score === null && !chainName) return "";

    var top = [];
    if (style) {
      top.push(
        '<span class="mc-grade" style="color:' + style.fg + ';background:' + style.fg + '22">' +
        style.label + "</span>"
      );
    }
    if (score !== null) {
      top.push('<span class="mc-score">' + score.toFixed(2) + "</span>");
    }
    var parts = ['<span class="row">' + top.join("") + "</span>"];
    var sub = [];
    if (chainName) sub.push(esc(chainName));
    // 精1 是默认值，人人都是，显示出来只是噪声；精2 以上才有区分意义
    if (reson >= 2) sub.push("精" + reson);
    if (sub.length) parts.push('<span class="mc-chain">' + sub.join(" · ") + "</span>");

    var title = c.name;
    if (score !== null) title += " · 声骸 " + score.toFixed(2);
    if (chainName) title += " · " + chainName;
    if (reson) title += " · 精" + reson;
    if (c.sonata) title += " · " + c.sonata;

    return '<span class="mc-cfg" title="' + esc(title) + '">' + parts.join("") + "</span>";
  };

  /** 角色卡描边：五星金色、四星钢蓝；共鸣链/评级决定彩框/红框。 */
  function decorateRarity() {
    Array.prototype.slice.call(document.querySelectorAll(".char-card,.own-card")).forEach(function (card) {
      var nameEl = card.querySelector(".cname");
      var name = nameEl ? nameEl.textContent.trim() : "";
      var q = QUALITY[name];
      card.classList.toggle("q5", q === 5);
      card.classList.toggle("q4", q === 4);
      var cid = card.getAttribute("data-id");
      var data = cid ? configScores[cid] : null;
      var chain = data && data.chain !== null && data.chain !== undefined ? Number(data.chain) : null;
      var score = data && data.score !== null && data.score !== undefined ? Number(data.score) : null;
      var isS = score !== null && isFinite(score) && score >= 175;
      var isFive = q === 5;
      var rainbow = isFive && chain !== null && isFinite(chain) && (chain >= 6 || (chain >= 2 && chain <= 6 && isS));
      var red = isFive && !rainbow && chain !== null && isFinite(chain) && ((chain === 2 || chain === 3) || (chain === 0 && isS));
      card.classList.toggle("cfg-rainbow", !!rainbow);
      card.classList.toggle("cfg-red", !!red);
    });
  }

  /* ---------- 面板注入 ---------- */
  function injectStyle() {
    if (document.getElementById("mcWebExtStyle")) return;
    var css = [
      /* 主C优先级面板（移植 desktop.js 的样式） */
      ".mc-mainc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:340px;overflow:auto}",
      ".mc-mainc-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:var(--r);background:var(--panel2);cursor:pointer;user-select:none}",
      ".mc-mainc-row:hover{border-color:var(--line2)}",
      ".mc-mainc-row.selected{border-color:var(--accent);background:var(--panel3)}",
      ".mc-mainc-drag{color:var(--dim);cursor:grab;font-size:14px;line-height:1}",
      ".mc-mainc-idx{color:var(--muted);font-size:11px;min-width:16px;text-align:right;font-variant-numeric:tabular-nums}",
      ".mc-mainc-av{width:28px;height:28px;border-radius:50%;overflow:hidden;flex:0 0 auto;background:var(--panel3);display:flex;align-items:center;justify-content:center}",
      ".mc-mainc-av img{width:100%;height:100%;object-fit:cover;display:block}",
      ".mc-mainc-av .initial{font-size:13px;color:var(--muted)}",
      ".mc-mainc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}",
      ".mc-mainc-count{color:var(--dim);font-size:11px;flex:0 0 auto}",
      ".mc-mainc-rules{display:flex;flex-direction:column;gap:4px}",
      ".mc-mainc-rule{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);user-select:none}",
      ".mc-mainc-rule.off{opacity:.5}",
      ".mc-mainc-rule .drag{color:var(--dim);cursor:grab;font-size:14px;line-height:1}",
      ".mc-rule-avs{display:flex;gap:2px;flex:0 0 auto}",
      ".mc-rule-avs img{width:22px;height:22px;border-radius:50%;object-fit:cover;display:block}",
      ".mc-rule-names{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}",
      ".mc-rule-state{font-size:11px;color:var(--dim);flex:0 0 auto}",
      /* 拖拽幽灵 / 占位（index.html 里可能已有，重复定义无害） */
      ".mc-sort-placeholder{border:1px dashed var(--accent-dim);border-radius:var(--r);background:rgba(76,194,255,.06)}",
      ".mc-drag-ghost{position:fixed;z-index:9999;pointer-events:none;opacity:.9;box-shadow:0 8px 24px rgba(0,0,0,.5);border-radius:var(--r);background:var(--panel3)}",
      "body.mc-drag-sorting{cursor:grabbing;user-select:none}",
      /* 保存状态灯 */
      "#mcSaveState{font-size:12px;margin-left:8px}",
      /* 顶部状态条 */
      ".mc-web-banner{display:flex;align-items:center;gap:10px;padding:6px 12px;background:var(--panel2);border-bottom:1px solid var(--line);font-size:12px;color:var(--muted);flex-wrap:wrap}",
      ".mc-web-banner .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:0 0 auto}",
      ".mc-web-banner .sp{flex:1}",
      ".mc-web-banner button{font-size:12px;padding:3px 10px}",
      /* 目标选择弹窗里的头像网格在 index.html 已定义，无需重复 */
      "@media(max-width:720px){.mc-mainc-grid{grid-template-columns:1fr}}",
      ".mc-limited{display:flex;align-items:center;gap:8px;margin-left:auto;padding:4px 10px;border:1px solid rgba(210,153,34,.55);border-radius:999px;background:rgba(210,153,34,.10);font-size:12px;color:#e9c46a;flex-wrap:wrap}",
      ".mc-limited .tag{background:#d29922;color:#1a1206;font-weight:700;font-size:11px;padding:1px 7px;border-radius:999px}",
      ".mc-limited .txt{color:var(--text)}",
      ".mc-limited button{margin-left:2px}",
      ".mc-minfo{margin-bottom:2px}",
      ".mc-minfo-limited{display:flex;align-items:center;gap:8px;padding:6px 10px;margin:4px 0 10px;border:1px solid rgba(210,153,34,.5);border-radius:10px;background:rgba(210,153,34,.08);font-size:12px;color:#e9c46a}",
      ".mc-minfo-limited .tag{background:#d29922;color:#1a1206;font-weight:700;font-size:11px;padding:1px 7px;border-radius:999px;flex:none}",
      ".mc-minfo-head{font-size:12px;color:var(--muted);margin:10px 0 6px;letter-spacing:.04em}",
      ".mc-minfo-list{display:flex;flex-direction:column;gap:4px}",
      ".mc-minfo-row{display:flex;gap:10px;align-items:flex-start;padding:5px 8px;border-radius:8px;background:var(--panel2);font-size:12px;line-height:1.6}",
      ".mc-minfo-row .nm{flex:0 0 96px;color:var(--text);display:flex;align-items:center;gap:5px}",
      ".mc-minfo-row .ds{flex:1;min-width:0;color:var(--muted);white-space:pre-wrap}",
      ".tag.mini{background:rgba(210,153,34,.9);color:#1a1206;font-size:10px;padding:0 5px;border-radius:999px;font-weight:700}",
      ".mc-minfo-roles summary{cursor:pointer;color:var(--muted);font-size:12px;margin:10px 0 6px}",
      "@media(max-width:720px){.mc-limited{margin-left:0;width:100%}.mc-minfo-row{flex-direction:column;gap:2px}.mc-minfo-row .nm{flex:none}}",
      ".mc-boss-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}",
      ".mc-boss-card{display:flex;gap:10px;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);align-items:center}",
      ".mc-boss-av{width:52px;height:52px;flex:0 0 auto;border-radius:10px;overflow:hidden;background:var(--panel3);display:flex;align-items:center;justify-content:center}",
      ".mc-boss-av img{width:100%;height:100%;object-fit:cover;display:block}",
      ".mc-boss-av .initial{font-size:18px;color:var(--muted)}",
      ".mc-boss-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
      ".mc-boss-name{font-size:13px;color:var(--text);display:flex;align-items:center;gap:6px}",
      ".mc-boss-rounds{font-size:10px;color:var(--dim);border:1px solid var(--line2);border-radius:999px;padding:0 6px;font-weight:400}",
      ".mc-boss-tags{display:flex;flex-wrap:wrap;gap:4px}",
      ".mc-boss-tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line2);color:var(--muted);white-space:nowrap}",
      ".mc-boss-desc{font-size:11px;color:var(--dim);line-height:1.5;white-space:pre-wrap}",
      "@media(max-width:720px){.mc-boss-grid{grid-template-columns:1fr}.mc-boss-av{width:44px;height:44px}}",
      ".char-card{position:relative;display:flex;flex-direction:column;padding:0;overflow:hidden;border-radius:10px}",
      ".char-card .avatar,.char-card>img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:0;display:block}",
      ".char-card .cname{font-size:11px;line-height:1.8;padding:0 2px;text-align:center;background:rgba(1,4,9,.62);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".char-card .mc-cfg{position:absolute;left:0;right:0;bottom:19px;display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:2px 5px 14px;pointer-events:none;background:linear-gradient(to top,rgba(1,4,9,.94) 40%,rgba(1,4,9,0))}",
  ".char-card .mc-cfg .row{display:flex;align-items:center;gap:4px;width:100%}",
      ".mc-grade{font-size:9px;font-weight:800;line-height:1;padding:2px 4px;border-radius:3px;border:1px solid currentColor;font-style:italic;flex:0 0 auto}",
      ".mc-score{font-size:11px;font-weight:700;color:#e6edf3;text-shadow:0 1px 3px #000;font-variant-numeric:tabular-nums;flex:0 0 auto}",
      ".mc-chain{font-size:9px;color:#b6c2cf;white-space:nowrap;text-shadow:0 1px 2px #000;opacity:.92}",
      ".char-card .badge{position:absolute;top:3px;right:3px;left:auto;margin:0;z-index:3;font-size:9px;padding:1px 4px;border-radius:3px}",
      ".char-card .badge.used-once{top:3px;right:3px;bottom:auto;left:auto}",
      "#pool,#ownGrid{grid-template-columns:repeat(auto-fill,minmax(92px,1fr))!important;gap:8px!important}",
      "@media(max-width:720px){#pool,#ownGrid{grid-template-columns:repeat(auto-fill,minmax(78px,1fr))!important}}",
      "#exhausted .char-card{opacity:.55}",
      "#exhausted .char-card .mc-cfg{display:none}",
      ".slot .char-card .mc-cfg{display:none}",
      ".mc-team-score{display:inline-flex;align-items:center;gap:4px;margin:0;font-size:10px;color:var(--dim);flex:none}",
      ".mc-team-score input{width:76px;background:var(--panel3);border:1px solid transparent;border-radius:5px;padding:2px 5px;color:var(--text);font-size:11px;text-align:right}",
      ".mc-team-score input:focus{border-color:var(--accent)}",
      ".mc-team-score input,.mc-mteam .score{appearance:textfield;-moz-appearance:textfield}",
      ".mc-team-score input::-webkit-outer-spin-button,.mc-team-score input::-webkit-inner-spin-button,.mc-mteam .score::-webkit-outer-spin-button,.mc-mteam .score::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}",
      ".mc-qrow{display:flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:0;border-radius:10px;background:var(--panel2);border:1px solid transparent;cursor:grab;min-width:0;user-select:none}",
      ".mc-qrow.dragging{opacity:.4;border:1px dashed var(--accent)}",
      ".mc-qrow.drop-before{box-shadow:inset 3px 0 0 var(--accent)}",
      ".mc-qrow.drop-after{box-shadow:inset -3px 0 0 var(--accent)}",
      ".mc-qrow .drag{width:16px;text-align:center;color:var(--dim);font-size:15px;flex:none}",
      ".mc-qrow .num{width:24px;text-align:center;color:var(--dim);font-family:var(--font-display);font-size:12px}",
      ".mc-qrow .avs{display:flex;flex:none}",
      ".mc-qrow .avs img{width:30px;height:30px;border-radius:6px;object-fit:cover;border:1px solid rgba(255,255,255,.08);margin-left:-6px;background:var(--panel3)}",
      ".mc-qrow .avs img:first-child{margin-left:0}",
      ".mc-qrow .names{flex:1;min-width:0;font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".mc-qrow .pts{width:92px;text-align:right;font-size:12px;color:var(--muted);flex:none}",
      ".mc-qrow .done-tag{font-size:10px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:1px 5px;flex:none}",
      ".mc-qrow{user-select:none;cursor:grab}",
      ".mc-mteam{user-select:none;-webkit-user-select:none}",
      ".mc-mteam img,.mc-qrow img{-webkit-user-drag:none;user-drag:none;user-select:none}",
      ".mc-qrow:active{cursor:grabbing}",
      ".mc-qrow.mc-qrow-ghost{opacity:.22;background:rgba(90,209,255,.07);border:1px dashed var(--accent)}",
      ".mc-qrow.mc-qrow-chosen{background:rgba(90,209,255,.08);border-color:rgba(90,209,255,.3)}",
      ".mc-qrow.mc-qrow-fallback{opacity:.98;background:var(--panel2);border-color:var(--accent);box-shadow:0 18px 42px rgba(0,0,0,.6);transform:rotate(1deg)}",
      ".mc-matrix{display:flex;flex-direction:column;gap:14px}",
      ".mc-matrix-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".mc-rounds{display:flex;gap:6px;flex-wrap:wrap}",
      ".mc-round-btn{background:var(--panel2);border:1px solid transparent;border-radius:8px;padding:7px 12px;font-size:13px;color:var(--muted);cursor:pointer}",
      ".mc-round-btn:hover{background:var(--panel3);color:var(--text)}",
      ".mc-round-btn.active{background:var(--accent);color:#04121c;border-color:var(--accent);font-weight:600}",
      ".mc-matrix-actions{margin-left:auto;display:flex;gap:8px}",
      ".mc-matrix-layout{display:grid;grid-template-columns:minmax(0,.95fr) minmax(0,1.25fr);gap:18px;align-items:start}",
      ".mc-matrix-panel{background:var(--panel);border:1px solid transparent;border-radius:14px;padding:14px;min-width:0}",
      ".mc-section-title{font-family:var(--font-display);font-size:14px;color:var(--muted);letter-spacing:.3px;margin-bottom:10px;display:flex;align-items:center;gap:8px}",
      ".mc-section-title .sub{font-size:12px;color:var(--dim);font-family:inherit;letter-spacing:0}",
      ".mc-mteam{display:flex;align-items:center;gap:8px;background:var(--panel2);border-radius:10px;padding:7px 8px;margin-bottom:7px}",
      ".mc-mteam .num{width:22px;text-align:center;font-family:var(--font-display);color:var(--dim);font-size:12px}",
      ".mc-mteam{cursor:grab}",
      ".mc-mteam-list{display:flex;flex-direction:column}",
      ".mc-mteam.mc-mteam-ghost{opacity:.22;background:rgba(90,209,255,.07);border:1px dashed var(--accent)}",
      ".mc-mteam.mc-mteam-chosen{background:rgba(90,209,255,.08)}",
      ".mc-mteam.mc-mteam-fallback{opacity:.98;background:var(--panel2);border:1px solid var(--accent);box-shadow:0 18px 42px rgba(0,0,0,.6);transform:rotate(1deg)}",
      ".mc-mteam input{cursor:text}",
      ".mc-mteam button{cursor:pointer}",
      ".mc-mteam .drag{width:14px;flex:none;text-align:center;color:var(--dim);cursor:grab;font-size:15px;line-height:1;user-select:none}",
      ".mc-mteam .drag:active{cursor:grabbing;color:var(--accent)}",
      ".mc-mteam.dragging{opacity:.35;border:1px dashed var(--accent)}",
      ".mc-mteam.drop-before{box-shadow:inset 0 3px 0 var(--accent)}",
      ".mc-mteam.drop-after{box-shadow:inset 0 -3px 0 var(--accent)}",
      ".mc-mteam-ghost{position:fixed;z-index:9999;pointer-events:none;opacity:.94;border:1px solid var(--accent);box-shadow:0 12px 30px rgba(0,0,0,.45);background:var(--panel2);border-radius:10px}",
      ".mc-mteam .dot{width:9px;height:9px;border-radius:50%;flex:none}",
      ".mc-mteam .avs{display:flex;flex:none}",
      ".mc-mteam .avs img{width:26px;height:26px;border-radius:6px;object-fit:cover;border:1px solid rgba(255,255,255,.08);margin-left:-5px;background:var(--panel3)}",
      ".mc-mteam .avs img:first-child{margin-left:0}",
      ".mc-mteam .nm{min-width:0;flex:1;font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".mc-mteam .score{width:92px;flex:none;text-align:right;font-size:13px;background:var(--panel3);border:1px solid transparent;border-radius:7px;padding:5px 8px;color:var(--text)}",
      ".mc-mteam .score:focus{border-color:var(--accent)}",
      ".mc-mteam .move{display:flex;flex-direction:column;gap:2px}",
      ".mc-mteam .move button{background:transparent;color:var(--dim);font-size:12px;padding:0 4px;line-height:1.2}",
      ".mc-mteam .move button:hover{color:var(--accent)}",
      ".mc-boss{background:var(--panel2);border:1px solid transparent;border-radius:12px;padding:11px 12px;margin-bottom:10px}",
      ".mc-boss-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}",
      ".mc-boss-code{font-family:var(--font-display);font-size:14px;color:var(--accent)}",
      ".mc-boss-name{font-size:13px;color:var(--text)}",
      ".mc-boss-score{margin-left:auto;font-size:12px;color:var(--dim)}",
      ".mc-boss-extra{font-size:11px;color:var(--gold)}",
      ".mc-bossbar{height:30px;background:var(--panel3);border-radius:7px;overflow:visible;display:flex;position:relative}",
      ".mc-bossbar .seg{height:100%;min-width:1px;position:relative}",
      ".mc-bossbar .seg span{font-size:10px;color:#06131c;font-weight:700;position:absolute;left:4px;top:7px;white-space:nowrap;pointer-events:none}",
      ".mc-bossbar .seg img{width:22px;height:22px;border-radius:5px;object-fit:cover;position:absolute;left:3px;top:4px;border:1px solid rgba(3,12,20,.75);background:var(--panel3);box-shadow:0 1px 4px rgba(0,0,0,.35)}",
      ".mc-bossbar .empty{height:100%;flex:1;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:12px}",
      ".mc-boss-segs{display:flex;flex-wrap:wrap;gap:8px;margin-top:7px;font-size:11px;color:var(--muted)}",
      ".mc-boss-segs i{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:4px}",
      ".mc-matrix-empty{padding:24px;color:var(--dim);font-size:13px;text-align:center}",
      ".mc-matrix-sum{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dim);margin-top:4px}",
    ].join("\n");
    var style = document.createElement("style");
    style.id = "mcWebExtStyle";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function installRulePriorityPanel() {
    if (document.getElementById("mcRulePriorityPanel")) return;
    var ruleList = document.getElementById("ruleList");
    var panel = ruleList && ruleList.closest ? ruleList.closest(".panel") : null;
    if (!panel || !panel.parentNode) return;

    var wrap = el("div", { className: "panel", id: "mcRulePriorityPanel" });
    wrap.appendChild(el("div", { className: "panel-title" }, "主C优先级（一键排布）"));
    wrap.appendChild(el("div", {
      className: "hint",
      style: "color:var(--dim);font-size:12px;margin-bottom:8px;line-height:1.6",
    }, "拖动主C调整整体优先级；点主C头像查看该分类下的规则，再拖动规则调整同一主C内的优先级。冲突规则会被跳过，不会把所有规则一起拖失效。"));
    wrap.appendChild(el("div", { className: "mc-mainc-grid", id: "mcMaincPriority" }));
    wrap.appendChild(el("div", { className: "panel-title", id: "mcMaincRulesTitle", style: "margin-top:12px" }, "主C规则优先级"));
    wrap.appendChild(el("div", { className: "mc-mainc-rules", id: "mcMaincRules" }));
    panel.parentNode.insertBefore(wrap, panel);
    renderRulePriority();
  }

  /* 顶栏状态条：账号信息 + 保存状态 + 导出分享 / 导入配队 */
  function installBanner(user, account) {
    if (document.getElementById("mcWebBanner")) return;
    var topbar = document.querySelector("header.topbar");
    if (!topbar) return;

    var bar = el("div", { className: "mc-web-banner", id: "mcWebBanner" });
    bar.appendChild(el("span", { className: "dot" }));

    var acc = account || {};
    var label = "鸣潮配队工具箱";
    if (acc.name) label += " · " + acc.name;
    if (acc.level) label += " Lv." + acc.level;
    if (acc.roleNum) label += " · " + acc.roleNum + " 角色";
    bar.appendChild(el("span", {}, label));

    bar.appendChild(el("span", { id: "mcSaveState" }, ""));
    bar.appendChild(el("span", { className: "sp" }));

    var btnSave = el("button", { className: "btn sm" }, "立即保存");
    btnSave.addEventListener("click", function () {
      Promise.resolve(flushSave()).then(function (ok) {
        safeToast(ok ? "已保存到云端" : "保存失败", ok ? "info" : "error");
      });
    });
    bar.appendChild(btnSave);

    var btnExport = el("button", { className: "btn sm" }, "导出分享");
    btnExport.title = "导出一个自带配置的 HTML，发给别人直接能看你的规则与队伍";
    btnExport.addEventListener("click", function () {
      if (typeof window.__MC_EXPORT_SHARE_PACK__ === "function") {
        window.__MC_EXPORT_SHARE_PACK__();
      } else {
        exportShareJson();
      }
    });
    bar.appendChild(btnExport);

    var fileInput = el("input", { type: "file", accept: "application/json,.json" });
    fileInput.hidden = true;
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      importBundle(f);
      fileInput.value = "";
    });
    bar.appendChild(fileInput);

    var btnImport = el("button", { className: "btn sm" }, "导入配队");
    btnImport.title = "导入之前导出的配队存档（JSON）";
    btnImport.addEventListener("click", function () { fileInput.click(); });
    bar.appendChild(btnImport);

    var btnReset = el("button", { className: "btn sm danger" }, "清空存档");
    btnReset.addEventListener("click", function () {
      if (!window.confirm("确认清空云端存档？你的规则、方案、队伍排布都会重置（角色表来自游戏数据，不受影响）。")) return;
      api("/reset", { method: "POST" }).then(function () {
        safeToast("已清空，正在重新加载…", "info");
        setTimeout(function () { window.location.reload(); }, 600);
      }).catch(function (err) {
        safeToast("清空失败：" + err.message, "error");
      });
    });
    bar.appendChild(btnReset);

    topbar.parentNode.insertBefore(bar, topbar.nextSibling);
  }

  /* ---------- 导出 / 导入 ---------- */
  var EXPORT_KEYS = [
    "mc_rules", "mc_presets", "mc_snapshots", "mc_current",
    "mc_team_names", "mc_team_done", "mc_matrix",
    "mc_rule_mainc_priority", "mc_rule_mainc_rule_order",
  ];

  function currentBundle() {
    // 只导出「用户编辑结果」：角色表来自游戏数据，带着反而会在别人那里过期
    var pack = { format: "wwtoolkit/1", exported_at: new Date().toISOString() };
    EXPORT_KEYS.forEach(function (k) {
      var v = window.state
        ? (k === "mc_rules" ? window.state.rules
          : k === "mc_presets" ? window.state.presets
          : k === "mc_snapshots" ? window.state.snapshots
          : k === "mc_current" ? { teams: window.state.current.teams, staminaUsed: window.state.current.staminaUsed }
          : deskStore[k])
        : deskStore[k];
      if (v !== undefined) pack[k] = v;
    });
    return pack;
  }

  function downloadJson(name, obj) {
    var text = JSON.stringify(obj, null, 1);
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportShareJson() {
    var stamp = new Date().toISOString().slice(0, 10);
    downloadJson("鸣潮配队存档-" + stamp + ".json", currentBundle());
    safeToast("已导出配队存档", "info");
  }

  function importBundle(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var pack;
      try {
        pack = JSON.parse(String(reader.result || "{}"));
      } catch (e) {
        safeToast("文件不是合法 JSON", "error");
        return;
      }
      if (!pack || typeof pack !== "object") {
        safeToast("文件内容不是配队存档", "error");
        return;
      }
      var applied = 0;
      EXPORT_KEYS.forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(pack, k)) return;
        deskStore[k] = pack[k];
        applied += 1;
      });
      if (!applied) {
        safeToast("这个文件里没有可导入的配队数据", "error");
        return;
      }
      if (pack.mc_rule_mainc_priority) {
        maincPriority = pack.mc_rule_mainc_priority.filter(function (x) { return typeof x === "string"; });
      }
      if (pack.mc_rule_mainc_rule_order) maincRuleOrder = pack.mc_rule_mainc_rule_order;

      try {
        if (typeof window.loadFromStore === "function") window.loadFromStore(null);
        if (mergedChars.length) window.state.characters = mergedChars;
        window.renderAll();
      } catch (e) {
        console.error("import render failed", e);
      }
      hookRenders();
      flushSave();
      safeToast("已导入 " + applied + " 项配队数据", "info");
    };
    reader.onerror = function () { safeToast("读取文件失败", "error"); };
    reader.readAsText(file, "utf-8");
  }

  var MATRIX_DATA = { rounds: [] };
  /* 由 boot() 在 bootstrap 之后用后端返回的矩阵数据填充 */
  function setMatrixData(data) {
    MATRIX_DATA = (data && Array.isArray(data.rounds)) ? data : { rounds: [] };
    matrix = null;
  }
  var MATRIX_COLORS = ["#5ad1ff", "#e9b45d", "#7ee787", "#ff7b72", "#c297ff",
                       "#58a6ff", "#f2cc60", "#39c5bb", "#ff9bce", "#a5d6ff",
                       "#d2a8ff", "#ffa657"];
  var matrix = null;

  function teamSig(team) {
    return (team || []).map(function (id) { return id || "-"; }).join("|");
  }
  function matrixColor(i) { return MATRIX_COLORS[i % MATRIX_COLORS.length]; }
  function matrixFmt(n) {
    n = Number(n) || 0;
    return n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  }
  function matrixRoundIds() {
    return MATRIX_DATA.rounds.map(function (r) { return r.id; });
  }
  function matrixFindRound(id) {
    for (var i = 0; i < MATRIX_DATA.rounds.length; i++) {
      if (MATRIX_DATA.rounds[i].id === id) return MATRIX_DATA.rounds[i];
    }
    return null;
  }
  function matrixEncounters() {
    var out = [];
    MATRIX_DATA.rounds.forEach(function (r, ri) {
      r.bosses.forEach(function (b, bi) {
        out.push({ round: r, boss: b, roundIndex: ri, bossIndex: bi, index: out.length });
      });
    });
    return out;
  }
  function matrixNonEmptyTeams() {
    var out = [];
    ((state.current && state.current.teams) || []).forEach(function (team, idx) {
      if (!team || !team.filter(Boolean).length) return;
      var members = team.filter(Boolean).map(function (id) { return charById(id); }).filter(Boolean);
      out.push({ idx: idx, team: team, sig: teamSig(team), members: members });
    });
    return out;
  }
  function matrixEnsure() {
    if (!matrix) {
      matrix = (deskStore.mc_matrix && typeof deskStore.mc_matrix === "object") ? deskStore.mc_matrix : {};
      if (!matrix.scores || typeof matrix.scores !== "object") matrix.scores = {};
      if (!Array.isArray(matrix.order)) matrix.order = [];
    }
    var currentTeams = matrixNonEmptyTeams();
    var teamCount = (state.current.teams || []).length;
    if (!matrix._slotSigs || typeof matrix._slotSigs !== "object") matrix._slotSigs = {};
    // 同一队伍位里换角色时，签名会变；把旧签名在顺序里的位置原地换成新签名，
    // 否则队伍会被当成“新队伍”追加到末尾，表现成拖人后队伍乱跳。
    if (matrix._teamCount === undefined || matrix._teamCount === teamCount) {
      currentTeams.forEach(function (t) {
        var key = String(t.idx);
        var oldSig = matrix._slotSigs[key];
        if (oldSig && oldSig !== t.sig) {
          var p = matrix.order.indexOf(oldSig);
          if (p >= 0) matrix.order[p] = t.sig;
          if (matrix.scores[oldSig] !== undefined && matrix.scores[t.sig] === undefined) {
            matrix.scores[t.sig] = matrix.scores[oldSig];
          }
        }
      });
    }
    var nextSlots = {};
    currentTeams.forEach(function (t) { nextSlots[String(t.idx)] = t.sig; });
    matrix._slotSigs = nextSlots;
    matrix._teamCount = teamCount;
    var live = {};
    currentTeams.forEach(function (t) { live[t.sig] = true; });
    matrix.order = matrix.order.filter(function (s) { return live[s]; });
    currentTeams.forEach(function (t) {
      if (matrix.order.indexOf(t.sig) < 0) matrix.order.push(t.sig);
    });
    Object.keys(matrix.scores).forEach(function (k) { if (!live[k]) delete matrix.scores[k]; });
    var ids = matrixRoundIds();
    if (!matrix.round || ids.indexOf(matrix.round) < 0) matrix.round = ids[0] || "R1";
    return matrix;
  }
  function saveMatrix() {
    deskStore.mc_matrix = matrix;
    scheduleSave();
    flushSave();
  }
  function matrixCurrentRound() {
    matrixEnsure();
    return matrixFindRound(matrix.round) || MATRIX_DATA.rounds[0] || null;
  }
  function matrixAllocate() {
    var m = matrixEnsure();
    var encs = matrixEncounters();
    var byIndex = {};
    var teams = {};
    var total = 0;
    var overflow = 0;
    var current = 0;
    if (!encs.length) return { encs: encs, byIndex: byIndex, teams: teams, total: 0, overflow: 0, current: 0 };
    var rem = encs[0].boss.base;
    var teamMap = {};
    matrixNonEmptyTeams().forEach(function (t) { teamMap[t.sig] = t; });
    m.order.forEach(function (sig) {
      var t = teamMap[sig];
      if (!t) return;
      var score = Math.max(0, Number(m.scores[sig]) || 0);
      if (score <= 0) return;
      total += score;
      var rec = { sig: sig, team: t, score: score, parts: [], allocated: 0, overflow: 0, bonus: 0 };
      teams[sig] = rec;
      var left = score;
      while (left > 0.000001 && current < encs.length) {
        var e = encs[current];
        var base = Math.max(1e-9, Number(e.boss.base) || 0);
        var take = Math.min(left, rem);
        if (take > 0.000001) {
          var start = (base - rem) / base * 100;
          var end = (base - rem + take) / base * 100;
          if (!byIndex[current]) byIndex[current] = [];
          byIndex[current].push({ sig: sig, team: t, start: start, end: end, amount: take });
          rec.parts.push({ enc: e, start: start, end: end, amount: take });
          rec.allocated += take;
          left -= take;
          rem -= take;
        }
        if (rem <= 0.000001) {
          if (e.boss.extra) {
            rec.bonus += e.boss.extra;
            /* 用户填的是游戏里队伍的总分，宝箱的 +1000 已经含在总分里，
               它不是对 boss 造成的伤害，不能继续拿去推进血条；
               每击杀一个宝箱，就从剩余可分分数里扣掉这 1000。 */
            left = Math.max(0, left - e.boss.extra);
          }
          current += 1;
          if (current < encs.length) rem = Math.max(1e-9, Number(encs[current].boss.base) || 0);
        } else {
          break;
        }
      }
      if (left > 0.000001) { rec.overflow = left; overflow += left; }
    });
    return { encs: encs, byIndex: byIndex, teams: teams, total: total, overflow: overflow, current: current };
  }
  function matrixTeamRow(t, pos, alloc) {
    var row = el("div", { className: "mc-mteam", "data-sig": t.sig, draggable: "false" });
    var drag = el("span", { className: "drag", title: "按住拖动排序" }, "⋮");
    row.appendChild(drag);
    row.appendChild(el("span", { className: "num" }, String(t.idx + 1)));
    row.appendChild(el("span", { className: "dot", style: "background:" + matrixColor(pos) }));
    var avs = el("div", { className: "avs" });
    t.members.forEach(function (c) {
      if (c.avatar) avs.appendChild(el("img", { src: c.avatar, alt: "", draggable: "false" }));
    });
    row.appendChild(avs);
    var memberText = t.members.map(function (c) { return c.name; }).join(" · ");
    var rowName = teamNames[t.idx] ? teamDisplayName(t.idx) + " · " + memberText : memberText;
    row.appendChild(el("span", { className: "nm", title: rowName }, rowName));
    var inp = el("input", { type: "number", min: "0", step: "1", className: "score", placeholder: "总分",
      title: "填游戏里这支队伍的总分；宝箱 +1000 已包含在总分里，会自动扣除", draggable: "false" });
    var score = Number(matrix.scores[t.sig]) || 0;
    inp.value = score ? String(score) : "";
    inp.addEventListener("input", function () {
      var v = Number(inp.value);
      matrix.scores[t.sig] = isFinite(v) && v > 0 ? v : 0;
      saveMatrix();
      decorateTeamScores();
      renderMatrixBosses();
      updateMatrixSum();
    });
    row.appendChild(inp);

    row.addEventListener("dragstart", function (e) { e.preventDefault(); });
    row.addEventListener("pointerdown", function (e) {
      if (window.Sortable) return;
      if (e.button !== 0 || (e.pointerType && e.pointerType === "touch")) return;
      if (e.target.closest("input,button,.move")) return;
      e.preventDefault();
      var startX = e.clientX, startY = e.clientY;
      var started = false, ghost = null, targetRow = null, wasBefore = false;
      var rowRect = row.getBoundingClientRect();
      var offsetY = e.clientY - rowRect.top;
      var pointerId = e.pointerId;

      function clearHints() { clearMatrixDropHints(); }

      function onMove(ev) {
        if (ev.pointerId !== pointerId) return;
        if (!started && Math.abs(ev.clientY - startY) < 4 && Math.abs(ev.clientX - startX) < 4) return;
        if (!started) {
          started = true;
          row.classList.add("dragging");
          document.body.classList.add("mc-matrix-dragging");
          ghost = row.cloneNode(true);
          ghost.classList.remove("dragging", "drop-before", "drop-after");
          ghost.classList.add("mc-mteam-ghost");
          ghost.style.width = rowRect.width + "px";
          ghost.style.left = (ev.clientX - 18) + "px";
          ghost.style.top = (ev.clientY - offsetY) + "px";
          document.body.appendChild(ghost);
        }
        ev.preventDefault();
        ghost.style.left = Math.max(4, Math.min(window.innerWidth - 120, ev.clientX - 18)) + "px";
        ghost.style.top = (ev.clientY - offsetY) + "px";
        if (ev.clientY < 90) window.scrollBy(0, -14);
        else if (ev.clientY > window.innerHeight - 90) window.scrollBy(0, 14);

        var under = document.elementFromPoint(ev.clientX, ev.clientY);
        var tr = under && under.closest ? under.closest(".mc-mteam") : null;
        if (tr === row) tr = null;
        if (tr) {
          var rect = tr.getBoundingClientRect();
          wasBefore = ev.clientY < rect.top + rect.height / 2;
          clearHints();
          tr.classList.add(wasBefore ? "drop-before" : "drop-after");
          targetRow = tr;
        } else {
          clearHints();
          targetRow = null;
        }
      }

      function finish(ev) {
        if (ev && ev.pointerId !== pointerId) return;
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerup", finish, true);
        document.removeEventListener("pointercancel", finish, true);
        row.classList.remove("dragging");
        document.body.classList.remove("mc-matrix-dragging");
        clearHints();
        if (ghost) { ghost.remove(); ghost = null; }
        if (!started || !targetRow) return;
        var targetSig = targetRow.getAttribute("data-sig");
        if (!targetSig || targetSig === t.sig) return;
        var order = matrixEnsure().order;
        var from = order.indexOf(t.sig);
        if (from < 0) return;
        order.splice(from, 1);
        var to = order.indexOf(targetSig);
        if (to < 0) return;
        if (!wasBefore) to += 1;
        order.splice(to, 0, t.sig);
        saveMatrix();
        renderMatrixTeams();
        renderMatrixBosses();
      }

      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
    });

    if (alloc && alloc.teams[t.sig] && alloc.teams[t.sig].overflow) {
      row.title = "还有 " + matrixFmt(alloc.teams[t.sig].overflow) + " 分没打到（已超过全部 boss 血量）";
    }
    return row;
  }
  function clearMatrixDropHints() {
    Array.prototype.slice.call(document.querySelectorAll(".mc-mteam.drop-before,.mc-mteam.drop-after,.mc-mteam.dragging,.team-card.drop-before,.team-card.drop-after,.team-card.dragging"))
      .forEach(function (el) { el.classList.remove("drop-before", "drop-after", "dragging"); });
  }
  function commitMatrixOrder() {
    var list = document.getElementById("mcMatrixTeamList");
    if (!list) return;
    var sigs = Array.prototype.slice.call(list.querySelectorAll(".mc-mteam"))
      .map(function (r) { return r.getAttribute("data-sig"); }).filter(Boolean);
    if (!sigs.length) return;
    var m = matrixEnsure();
    m.order = sigs.concat(m.order.filter(function (s) { return sigs.indexOf(s) < 0; }));
    saveMatrix();
  }

  function initMatrixDrag() {
    var list = document.getElementById("mcMatrixTeamList");
    if (!list) return;
    Array.prototype.slice.call(list.querySelectorAll(".mc-mteam")).forEach(function (row) {
      if (row._mcDragBound) return;
      row._mcDragBound = true;
      row.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        if (e.target.closest("input,button,textarea,a")) return;
        var startX = e.clientX, startY = e.clientY;
        var rowRect = row.getBoundingClientRect();
        var offsetY = e.clientY - rowRect.top;
        var pointerId = e.pointerId;
        var started = false, ghost = null, placeholder = null;

        function rows() {
          return Array.prototype.slice.call(list.querySelectorAll(".mc-mteam")).filter(function (x) { return x !== row; });
        }
        function movePlaceholder(x, y) {
          var before = null;
          rows().forEach(function (it) {
            var r = it.getBoundingClientRect();
            if (y < r.top + r.height / 2) { if (!before) before = it; }
          });
          var old = placeholder.getBoundingClientRect();
          var oldPos = rows().map(function (it) { return [it, it.getBoundingClientRect()]; });
          if (before) list.insertBefore(placeholder, before);
          else list.appendChild(placeholder);
          var now = placeholder.getBoundingClientRect();
          if (old.top === now.top && old.left === now.left) return;
          oldPos.forEach(function (pair) {
            var it = pair[0], r0 = pair[1], r1 = it.getBoundingClientRect();
            var dx = r0.left - r1.left, dy = r0.top - r1.top;
            if (!dx && !dy) return;
            it.style.transition = "none";
            it.style.transform = "translate(" + dx + "px," + dy + "px)";
            requestAnimationFrame(function () {
              it.style.transition = "transform .16s ease";
              it.style.transform = "";
              setTimeout(function () { it.style.transition = ""; }, 180);
            });
          });
        }
        function onMove(ev) {
          if (ev.pointerId !== pointerId) return;
          if (!started && Math.abs(ev.clientY - startY) < 4 && Math.abs(ev.clientX - startX) < 4) return;
          if (!started) {
            started = true;
            placeholder = el("div", { className: "mc-sort-placeholder" });
            placeholder.style.height = rowRect.height + "px";
            placeholder.style.width = rowRect.width + "px";
            list.insertBefore(placeholder, row);
            row.style.display = "none";
            ghost = row.cloneNode(true);
            ghost.classList.add("mc-drag-ghost");
            ghost.style.width = rowRect.width + "px";
            ghost.style.height = rowRect.height + "px";
            ghost.style.left = rowRect.left + "px";
            ghost.style.top = rowRect.top + "px";
            ghost.style.display = "flex";
            document.body.appendChild(ghost);
            document.body.classList.add("mc-drag-sorting");
          }
          ev.preventDefault();
          ghost.style.left = rowRect.left + "px";
          ghost.style.top = (ev.clientY - offsetY) + "px";
          movePlaceholder(ev.clientX, ev.clientY);
          if (ev.clientY < 80) window.scrollBy(0, -10);
          else if (ev.clientY > window.innerHeight - 80) window.scrollBy(0, 10);
        }
        function finish(ev) {
          if (ev && ev.pointerId !== pointerId) return;
          document.removeEventListener("pointermove", onMove, true);
          document.removeEventListener("pointerup", finish, true);
          document.removeEventListener("pointercancel", finish, true);
          if (!started) return;
          row.style.display = "";
          if (placeholder && placeholder.parentNode) {
            placeholder.parentNode.insertBefore(row, placeholder);
            placeholder.remove();
          }
          if (ghost) ghost.remove();
          document.body.classList.remove("mc-drag-sorting");
          var sigs = Array.prototype.slice.call(list.querySelectorAll(".mc-mteam"))
            .map(function (r) { return r.getAttribute("data-sig"); }).filter(Boolean);
          if (sigs.length) {
            var m = matrixEnsure();
            m.order = sigs.concat(m.order.filter(function (s) { return sigs.indexOf(s) < 0; }));
            saveMatrix();
          }
          setTimeout(function () {
            renderMatrixTeams();
            renderMatrixBosses();
            if (typeof window.renderTeams === "function") window.renderTeams();
          }, 0);
        }
        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("pointerup", finish, true);
        document.addEventListener("pointercancel", finish, true);
      });
    });
  }

  function initMatrixSortable() {
    var list = document.getElementById("mcMatrixTeamList");
    if (!list || !window.Sortable) return;
    if (list._mcSortable) { try { list._mcSortable.destroy(); } catch (e) {} list._mcSortable = null; }
    list._mcSortable = new Sortable(list, {
      animation: 180,
      draggable: ".mc-mteam",
      filter: "input,button",
      preventOnFilter: false,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      ghostClass: "mc-mteam-ghost",
      chosenClass: "mc-mteam-chosen",
      dragClass: "mc-mteam-dragging",
      fallbackClass: "mc-mteam-fallback",
      swapThreshold: 0.65,
      invertSwap: false,
      scroll: true,
      scrollSensitivity: 60,
      scrollSpeed: 12,
      bubbleScroll: true,
      onStart: function () { document.body.classList.add("mc-sortable-dragging"); },
      onChange: function () { commitMatrixOrder(); },
      onEnd: function () {
        document.body.classList.remove("mc-sortable-dragging");
        commitMatrixOrder();
        setTimeout(function () {
          renderMatrixTeams();
          renderMatrixBosses();
          if (typeof window.renderTeams === "function") window.renderTeams();
        }, 0);
      }
    });
  }

  function renderMatrixTeams() {
    var box = document.getElementById("mcMatrixTeams");
    if (!box) return;
    box.innerHTML = "";
    var teams = matrixNonEmptyTeams();
    if (!teams.length) {
      box.appendChild(el("div", { className: "mc-matrix-empty" }, "先在「配队」页组队，再回来填预估分。"));
      return;
    }
    var bySig = {};
    teams.forEach(function (t) { bySig[t.sig] = t; });
    var alloc = matrixAllocate();
    var order = matrixEnsure().order;
    var list = el("div", { className: "mc-mteam-list", id: "mcMatrixTeamList" });
    order.forEach(function (sig, pos) {
      var t = bySig[sig];
      if (t) list.appendChild(matrixTeamRow(t, pos, alloc));
    });
    box.appendChild(list);
    var sum = el("div", { className: "mc-matrix-sum", id: "mcMatrixSum" });
    box.appendChild(sum);
    updateMatrixSum();
    initMatrixDrag();
  }
  function updateMatrixSum() {
    var sum = document.getElementById("mcMatrixSum");
    if (!sum) return;
    var alloc = matrixAllocate();
    sum.innerHTML = "";
    sum.appendChild(el("span", null, "已填 " + alloc.total.toLocaleString("zh-CN") + " 分"));
    sum.appendChild(el("span", { style: "font-size:11px;color:var(--dim)" },
      "按游戏队伍总分填，宝箱 +1000 自动扣除"));
    if (alloc.overflow) sum.appendChild(el("span", { style: "color:var(--warn)" },
      "溢出 " + matrixFmt(alloc.overflow) + " 分（超过所有 boss）"));
  }
  function matrixMove(sig, delta) {
    var m = matrixEnsure();
    var i = m.order.indexOf(sig);
    var j = i + delta;
    if (i < 0 || j < 0 || j >= m.order.length) return;
    var tmp = m.order[i]; m.order[i] = m.order[j]; m.order[j] = tmp;
    saveMatrix();
    renderMatrixTeams();
    renderMatrixBosses();
    if (typeof window.renderTeams === "function") window.renderTeams();
  }
  function renderMatrixRounds() {
    var box = document.getElementById("mcMatrixRounds");
    if (!box) return;
    box.innerHTML = "";
    matrixRoundIds().forEach(function (id) {
      var b = el("button", { className: "mc-round-btn" + (matrix.round === id ? " active" : ""),
        title: id + " 轮" }, id);
      b.addEventListener("click", function () {
        matrix.round = id; saveMatrix(); renderMatrixRounds(); renderMatrixBosses();
      });
      box.appendChild(b);
    });
  }
  /** 拖动血条交界：左边队伍的预估分按拖动的百分比增减。 */
  function matrixBoundaryDrag(e, seg, boss, bar) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!seg || !seg.team || !boss || !bar) return;
    var width = bar.getBoundingClientRect().width || 1;
    var startX = e.clientX;
    var oldEnd = seg.end;
    var oldScore = Number(matrix.scores[seg.sig]) || 0;
    var base = Math.max(1e-9, Number(boss.base) || 1);
    var pointerId = e.pointerId;
    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      var delta = (ev.clientX - startX) / width * 100;
      var newEnd = Math.max(seg.start + 0.2, Math.min(99.8, oldEnd + delta));
      var dScore = (newEnd - oldEnd) / 100 * base;
      matrix.scores[seg.sig] = Math.max(0, oldScore + dScore);
      renderMatrixBosses();
      updateMatrixSum();
    }
    function finish(ev) {
      if (ev && ev.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true);
      saveMatrix();
      decorateTeamScores();
      renderMatrixTeams();
      renderMatrixBosses();
      updateMatrixSum();
    }
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
  }

  function renderMatrixBosses() {
    var box = document.getElementById("mcMatrixBosses");
    if (!box) return;
    box.innerHTML = "";
    var round = matrixCurrentRound();
    if (!round) {
      box.appendChild(el("div", { className: "mc-matrix-empty" }, "矩阵数据未加载。"));
      return;
    }
    var alloc = matrixAllocate();
    round.bosses.forEach(function (boss, bi) {
      var encIndex = 0;
      for (var i = 0; i < MATRIX_DATA.rounds.length; i++) {
        if (MATRIX_DATA.rounds[i].id === round.id) { encIndex = i * round.bosses.length + bi; break; }
      }
      var segs = alloc.byIndex[encIndex] || [];
      var card = el("div", { className: "mc-boss" });
      var head = el("div", { className: "mc-boss-head" });
      head.appendChild(el("span", { className: "mc-boss-code" }, matrixBossLabel(boss)));
      head.appendChild(el("span", { className: "mc-boss-score" },
        "血条分 " + matrixFmt(boss.base)));
      if (boss.extra) head.appendChild(el("span", { className: "mc-boss-extra" }, "+" + matrixFmt(boss.extra) + " 额外"));
      card.appendChild(head);
      var bar = el("div", { className: "mc-bossbar" });
      if (!segs.length) {
        bar.appendChild(el("div", { className: "empty" }, "未打"));
      } else {
        var last = 0;
        segs.forEach(function (s) {
          if (s.start > last + 0.05) {
            var gap = el("div", { className: "seg", style: "width:" + (s.start - last) + "%;background:var(--panel3)" });
            bar.appendChild(gap);
          }
          var pct = Math.max(0.5, s.end - s.start);
          var seg = el("div", { className: "seg", style: "width:" + pct + "%;background:" + matrixColor(matrix.order.indexOf(s.sig)),
            title: "队伍 " + (s.team.idx + 1) + " · " + matrixTeamMembers(s.team) + " · " + s.start.toFixed(1) + "%–" + s.end.toFixed(1) + "%" });
          var leader = s.team.members && s.team.members[0];
          if (pct > 4 && leader && leader.avatar) seg.appendChild(el("img", { src: leader.avatar, alt: "" }));
          else if (pct > 9) seg.appendChild(el("span", null, "队" + (s.team.idx + 1)));
          bar.appendChild(seg);
          last = Math.max(last, s.end);
        });
        for (var hi = 0; hi < segs.length - 1; hi++) {
          var leftSeg = segs[hi], rightSeg = segs[hi + 1];
          if (leftSeg.end < 99.5 && Math.abs(leftSeg.end - rightSeg.start) < 0.6) {
            (function (left) {
              var bh = el("div", { className: "mc-boundary", style: "left:" + left.end + "%",
                title: "拖动交界：调整队伍 " + (left.team.idx + 1) + " 的分数" });
              bh.addEventListener("pointerdown", function (e) { matrixBoundaryDrag(e, left, boss, bar); });
              bar.appendChild(bh);
            })(leftSeg);
          }
        }
      }
      card.appendChild(bar);
      if (segs.length) {
        var legend = el("div", { className: "mc-boss-segs" });
        segs.forEach(function (s) {
          var item = el("span");
          item.appendChild(el("i", { style: "background:" + matrixColor(matrix.order.indexOf(s.sig)) }));
          item.appendChild(document.createTextNode("队伍 " + (s.team.idx + 1) + " " +
            s.start.toFixed(1) + "–" + s.end.toFixed(1) + "%"));
          legend.appendChild(item);
        });
        card.appendChild(legend);
      }
      box.appendChild(card);
    });
  }
  function renderMatrix() {
    if (!document.getElementById("tab-matrix")) return;
    matrixEnsure();
    renderMatrixRounds();
    renderMatrixTeams();
    renderMatrixBosses();
  }
  function matrixBossLabel(boss) {
    if (boss && (boss.slot === 5 || boss.isChest)) return "宝箱";
    var letter = boss && boss.slot >= 1 && boss.slot <= 4 ? "ABCD".charAt(boss.slot - 1) : "?";
    return "怪物" + letter;
  }
  function matrixTeamMembers(t) {
    return t && t.members ? t.members.map(function (c) { return c.name; }).join(" / ") : "";
  }
  function matrixChartTeamLabel(t) {
    var mem = matrixTeamMembers(t);
    return teamDisplayName(t.idx) + (mem ? " · " + mem : "");
  }
  function chartBoundaryDrag(e, seg, boss, bar, body) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!seg || !seg.team || !boss || !bar || !body) return;
    var width = bar.getBoundingClientRect().width || 1;
    var startX = e.clientX;
    var oldEnd = seg.end;
    var oldScore = Number(matrix.scores[seg.sig]) || 0;
    var base = Math.max(1e-9, Number(boss.base) || 1);
    var pointerId = e.pointerId;
    function refresh() {
      var top = body.scrollTop;
      fillMatrixChart(body);
      body.scrollTop = top;
    }
    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      var delta = (ev.clientX - startX) / width * 100;
      var newEnd = Math.max(seg.start + 0.2, Math.min(99.8, oldEnd + delta));
      var dScore = (newEnd - oldEnd) / 100 * base;
      matrix.scores[seg.sig] = Math.max(0, oldScore + dScore);
      refresh();
    }
    function finish(ev) {
      if (ev && ev.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true);
      saveMatrix();
      decorateTeamScores();
      renderMatrixTeams();
      renderMatrixBosses();
      updateMatrixSum();
      refresh();
    }
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
  }
  function fillMatrixChart(body) {
    var alloc = matrixAllocate();
    body.innerHTML = "";
    var used = {};
    alloc.encs.forEach(function (e, i) { if (alloc.byIndex[i] && alloc.byIndex[i].length) used[e.round.id] = true; });
    if (!Object.keys(used).length) {
      body.appendChild(el("div", { className: "mc-matrix-empty" }, "还没有填写分数或队伍顺序。"));
    } else {
      var legend = el("div", { className: "mc-mchart-legend" });
      alloc.encs.length && matrixEnsure().order.forEach(function (sig) {
        var rec = alloc.teams[sig];
        if (!rec) return;
        var item = el("span", { className: "mc-mchart-team" });
        item.appendChild(el("i", { style: "background:" + matrixColor(matrix.order.indexOf(sig)) }));
        var avs = el("span", { className: "avs" });
        rec.team.members.forEach(function (c) { if (c.avatar) avs.appendChild(el("img", { src: c.avatar, alt: "" })); });
        item.appendChild(avs);
        item.appendChild(el("span", { className: "tn" }, teamDisplayName(rec.team.idx)));
        item.appendChild(el("span", { className: "mems", title: matrixTeamMembers(rec.team) }, matrixTeamMembers(rec.team)));
        item.appendChild(el("span", { className: "pts" }, matrixFmt(rec.score) + " 分" +
          (rec.bonus ? "（宝箱 +" + matrixFmt(rec.bonus) + "）" : "")));
        legend.appendChild(item);
      });
      body.appendChild(legend);
      MATRIX_DATA.rounds.forEach(function (round) {
        if (!used[round.id]) return;
        var rb = el("div", { className: "mc-mchart-round" });
        rb.appendChild(el("h3", null, round.id));
        round.bosses.forEach(function (boss, bi) {
          var encIndex = 0;
          for (var i = 0; i < MATRIX_DATA.rounds.length; i++) {
            if (MATRIX_DATA.rounds[i].id === round.id) { encIndex = i * round.bosses.length + bi; break; }
          }
          var segs = alloc.byIndex[encIndex] || [];
          var row = el("div", { className: "mc-mchart-row" });
          var lab = el("div", { className: "mc-mchart-label" });
          lab.appendChild(el("b", null, matrixBossLabel(boss)));
          var done = segs.reduce(function (n, s) { return Math.max(n, s.end); }, 0);
          lab.appendChild(el("span", { className: "pct" }, done.toFixed(1) + "%"));
          row.appendChild(lab);
          var bar = el("div", { className: "mc-mchart-bar" });
          if (!segs.length) bar.appendChild(el("div", { style: "flex:1;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:11px" }, "未打"));
          segs.forEach(function (s) {
            var seg = el("div", { className: "seg", title: matrixChartTeamLabel(s.team) + " · " + s.start.toFixed(1) + "–" + s.end.toFixed(1) + "%",
              style: "width:" + (s.end - s.start) + "%;background:" + matrixColor(matrix.order.indexOf(s.sig)) });
            var leader = s.team.members && s.team.members[0];
            if (s.end - s.start > 4 && leader && leader.avatar) seg.appendChild(el("img", { src: leader.avatar, alt: "" }));
            bar.appendChild(seg);
          });
          for (var hi = 0; hi < segs.length - 1; hi++) {
            (function (left) {
              if (left.end < 99.5 && Math.abs(left.end - segs[hi + 1].start) < 0.6) {
                var bh = el("div", { className: "mc-mchart-boundary", style: "left:" + left.end + "%",
                  title: "拖动交界：调整队伍 " + (left.team.idx + 1) + " 的分数" });
                bh.addEventListener("pointerdown", function (e) { chartBoundaryDrag(e, left, boss, bar, body); });
                bar.appendChild(bh);
              }
            })(segs[hi]);
          }
          row.appendChild(bar);
          if (segs.length) {
            var legend2 = el("div", { className: "mc-mchart-segs" });
            segs.forEach(function (s) {
              var item = el("span");
              item.appendChild(el("i", { style: "background:" + matrixColor(matrix.order.indexOf(s.sig)) }));
              item.appendChild(document.createTextNode(matrixChartTeamLabel(s.team) + "  " + s.start.toFixed(1) + "–" + s.end.toFixed(1) + "%"));
              legend2.appendChild(item);
            });
            row.appendChild(legend2);
          }
          rb.appendChild(row);
        });
        body.appendChild(rb);
      });
      var sum = el("div", { className: "mc-matrix-sum" });
      sum.appendChild(el("span", null, "总投入 " + alloc.total.toLocaleString("zh-CN") + " 分"));
      sum.appendChild(el("span", { style: "font-size:11px;color:var(--dim)" },
        "按游戏队伍总分填，宝箱 +1000 自动扣除"));
      if (alloc.overflow) sum.appendChild(el("span", { style: "color:var(--warn)" }, "溢出 " + matrixFmt(alloc.overflow) + " 分"));
      body.appendChild(sum);
    }
  }
  function openMatrixChart() {
    var overlay = el("div", { id: "mcMatrixChartOverlay" });
    var box = el("div", { className: "mc-mchart" });
    var head = el("div", { className: "mc-mchart-head" });
    head.appendChild(el("span", { className: "title" }, "伤害归属图"));
    head.appendChild(el("span", { className: "sub", style: "font-size:12px;color:var(--dim)" }, "拖动血条交界可调分"));
    head.appendChild(el("span", { className: "sp" }));
    var close = el("button", { className: "btn sm" }, "× 关闭");
    close.addEventListener("click", function () { overlay.remove(); });
    head.appendChild(close); box.appendChild(head);
    var body = el("div", { className: "mc-mchart-body" });
    box.appendChild(body); overlay.appendChild(box); document.body.appendChild(overlay);
    fillMatrixChart(body);
  }
  /* ================= 全局快速排序（缩略图） ================= */
  function installQuickOrderButtons() {
    var addBtn = document.getElementById("btnAddTeam");
    if (addBtn && addBtn.parentNode && !document.getElementById("mcBtnQuickOrder")) {
      var b = el("button", { className: "btn sm primary", id: "mcBtnQuickOrder",
        title: "打开缩略图，快速调整全局队伍顺序" }, "快速排序");
      b.addEventListener("click", openQuickOrder);
      addBtn.parentNode.insertBefore(b, addBtn);
    }
    var actions = document.querySelector(".mc-matrix-actions");
    if (actions && !document.getElementById("mcMatrixQuickOrder")) {
      var mb = el("button", { className: "btn sm", id: "mcMatrixQuickOrder",
        title: "打开缩略图，快速调整全局队伍顺序" }, "快速排序");
      mb.addEventListener("click", openQuickOrder);
      actions.insertBefore(mb, actions.firstChild);
    }
  }

  function installConfigButtons() {
    function addPair(ref, suffix) {
      if (!ref || document.getElementById("mcBtnConfig" + suffix)) return;
      var fileBtn = el("button", { className: "btn sm", id: "mcBtnConfig" + suffix,
        title: "选择 WutheringWavesUID 配置图，自动填充共鸣链和声骸分数" }, "配置识别");
      fileBtn.addEventListener("click", recognizeConfig);
      ref.parentNode.insertBefore(fileBtn, ref);
      var clipBtn = el("button", { className: "btn sm primary", id: "mcBtnClipConfig" + suffix,
        title: "读取剪贴板里的练度长图并识别（先在截图工具里复制）" }, "粘贴配置");
      clipBtn.addEventListener("click", recognizeConfigClipboard);
      ref.parentNode.insertBefore(clipBtn, fileBtn.nextSibling);
    }
    addPair(document.getElementById("btnAddTeam"), "Team");
    var charsRow = document.querySelector("#tab-chars .panel .row");
    if (charsRow) addPair(document.getElementById("mcBtnPasteChars") || charsRow.lastElementChild, "Chars");
  }

  function configButtons() {
    return [document.getElementById("mcBtnConfigTeam"), document.getElementById("mcBtnConfigChars"),
            document.getElementById("mcBtnClipConfigTeam"), document.getElementById("mcBtnClipConfigChars")].filter(Boolean);
  }
  function configBusy(on) {
    configButtons().forEach(function (b) {
      if (!b.getAttribute("data-label")) b.setAttribute("data-label", b.textContent);
      b.disabled = on;
      if (on) b.textContent = "识别中…";
      else b.textContent = b.getAttribute("data-label");
    });
  }
  function openConfigReview(r) {
    try {
      configBusy(false);
      var allChars = (r.characters || []).slice();
      var unknown = (r.unknown_rows || []).slice();
      function isUncertain(c) {
        // 判定放在识别层（app/config_recognizer.py），和 tools/calib_conf.py 用同一套标定：
        // conf = 第一名与第二名的混合分之差，实测 370 行只有 7 行错、阈值 0.10 能全部挑出来。
        // 前端不再自己算阈值——绝对匹配数会随裁剪放大倍数变，一改缩放就得重标定。
        if (c && typeof c.need_confirm === "boolean") return c.need_confirm;
        var cands = (c.candidates || []).filter(function (x) { return x && x.name; });
        if (!cands.length) return true;
        if (c.candidates && c.candidates.length === 0) return true;
        if (c.chain_issue) return true;
        // 吟霖/锁暝头像高度相似，只要涉及这两个名字就交给用户确认
        var ambiguousNames = { "吟霖": 1, "锁暝": 1 };
        if (ambiguousNames[c.name]) return true;
        for (var i = 0; i < Math.min(3, cands.length); i++) {
          if (ambiguousNames[cands[i].name]) return true;
        }
        // matches 是 SIFT 好匹配的加权分，绝对量级取决于头像裁剪的放大倍数：
        // 旧实现放大整图时中位 ~34，新实现只放大裁剪时中位 ~12。
        // 因此判据以「第一名与第二名的差距」为主，绝对下限只作兜底，否则每张图都会全量弹确认页。
        var top = Number(cands[0].matches) || 0;
        var second = cands[1] ? (Number(cands[1].matches) || 0) : 0;
        if (top < 7) return true;
        if (second >= Math.max(3, top * 0.78)) return true;
        return false;
      }
      var autoChars = allChars.filter(function (c) { return !isUncertain(c); });
      var chars = allChars.filter(isUncertain);
      if (!chars.length && !unknown.length) { applyConfigResult(r); return; }
      var byName = {};
      (state.characters || []).forEach(function (c) { byName[c.name] = c; });
      var allNames = (state.characters || []).map(function (c) { return c.name; }).sort(function (a, b) {
        return String(a).localeCompare(String(b), "zh-CN");
      });

      if (!document.getElementById("mcReviewStyle")) {
        var st = document.createElement("style");
        st.id = "mcReviewStyle";
        st.textContent = [
          ".mc-review-mask{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:24px}",
          ".mc-review-panel{width:min(1180px,96vw);max-height:92vh;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden}",
          ".mc-review-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}",
          ".mc-review-head h3{margin:0;font-size:17px;color:var(--text);font-family:var(--font-display)}",
          ".mc-review-head .sub{color:var(--dim);font-size:12px}",
          ".mc-review-body{padding:12px 16px;overflow:auto;flex:1}",
          ".mc-review-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}",
          ".mc-rv-card{display:flex;gap:8px;align-items:flex-start;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:8px;min-width:0}",
          ".mc-rv-card.unknown{border-style:dashed;border-color:rgba(255,180,80,.45)}",
          ".mc-rv-av{width:42px;height:42px;flex:none;border-radius:8px;overflow:hidden;background:var(--panel3)}",
          ".mc-rv-av img{width:42px;height:42px;object-fit:cover;display:block}",
          ".mc-rv-main{flex:1;min-width:0}",
          ".mc-rv-select{width:100%;min-width:0;background:var(--panel3);border:1px solid var(--line);border-radius:5px;color:var(--text);font-size:12px;padding:2px 4px}",
          ".mc-rv-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--dim);font-size:10px;margin-top:3px}",
          ".mc-rv-check{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--muted);margin-top:3px;cursor:pointer}",
          ".mc-rv-line{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--dim);margin-top:4px;white-space:nowrap;min-width:0}",
          ".mc-rv-line>span{flex:none;white-space:nowrap}",
          ".mc-rv-line select{min-width:0;max-width:100%}",
          ".mc-rv-shots{display:flex;gap:6px;margin-top:6px}",
          ".mc-rv-shot{position:relative;width:58px;height:58px;flex:none;border-radius:6px;overflow:hidden;background:#000;border:1px solid var(--line);cursor:zoom-in}",
          ".mc-rv-shot img{width:100%;height:100%;object-fit:cover;display:block}",

          ".mc-rv-zoom{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;cursor:zoom-out}",
          ".mc-rv-zoom img{max-width:min(560px,88vw);max-height:82vh;image-rendering:auto;border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.7);background:#000}",
          ".mc-rv-chain{background:var(--panel3);border:1px solid var(--line);border-radius:4px;color:var(--text);font-size:10px;padding:1px 3px}",
          ".mc-rv-chain-btns{display:none}",
          ".mc-rv-cbtn{width:18px;height:18px;border-radius:4px;border:1px solid rgba(255,255,255,.25);color:#fff;font-size:10px;line-height:1;cursor:pointer;padding:0;opacity:.72}",
          ".mc-rv-cbtn.on{outline:2px solid #fff;opacity:1}",
          ".mc-review-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--line)}",
          ".mc-review-foot .hint{flex:1;color:var(--dim);font-size:11px;align-self:center}",
        ].join("\n");
        document.head.appendChild(st);
      }

      var mask = el("div", { className: "mc-review-mask" });
      var panel = el("div", { className: "mc-review-panel" });
      var head = el("div", { className: "mc-review-head" });
      head.appendChild(el("h3", null, "配置识别结果确认"));
      var total = chars.length + unknown.length;
      head.appendChild(el("span", { className: "sub" },
        "自动采用 " + autoChars.length + " 行 · 需要确认 " + total + " 行"));
      panel.appendChild(head);
      var body = el("div", { className: "mc-review-body" });
      var warnList = (r.warnings || []).filter(Boolean);
      if (warnList.length) {
        body.appendChild(el("div", {
          style: "margin-bottom:10px;padding:8px 10px;border-radius:8px;" +
            "border:1px solid rgba(255,180,80,.45);background:rgba(255,180,80,.10);" +
            "color:#f0c674;font-size:11px;line-height:1.7"
        }, warnList.join("；")));
      }
      var grid = el("div", { className: "mc-review-grid" });
      body.appendChild(grid);
      panel.appendChild(body);

      var rows = [];
      function optionList(selected, candidates) {
        var seen = {}, opts = [];
        (candidates || []).forEach(function (x) {
          if (!x || !x.name || seen[x.name]) return;
          seen[x.name] = true;
          opts.push({ name: x.name, label: x.name + " · 匹配" + (x.matches || 0) });
        });
        allNames.forEach(function (n) { if (!seen[n]) { seen[n] = true; opts.push({ name: n, label: n }); } });
        return opts;
      }
      /** 存档里上一次这个角色的精炼值。本次图太小读不到时用它兜底，避免重识别把已有数据清掉 */
      function prevRefineFor(name, score) {
        var lc = byName[name];
        if (!lc) return null;
        var lid = localCharIdForConfig(lc);
        if (!lid) return null;
        var old = configScores[String(lid)];
        // 分数必须对得上才算"同一行"。否则上一轮可能是把这个角色认成了别的行，
        // 沿用会把那个角色的精炼挪过来（实测踩过：折枝显示精5，其实属于另一行）。
        if (!old || old.score === null || old.score === undefined) return null;
        if (score === null || score === undefined) return null;
        if (Math.abs(Number(old.score) - Number(score)) > 0.01) return null;
        var v = old.weapon && old.weapon.refine;
        return v ? Number(v) : null;
      }
      /** 武器精炼下拉：低分辨率图里精炼角标只有 8~9px，物理上读不出来，靠这里人工补 */
      function buildRefineSelect(entry) {
        var line = el("div", { className: "mc-rv-line" });
        line.appendChild(el("span", null, "武器精炼"));
        var box = el("select", { className: "mc-rv-chain" });
        var cur = entry.weapon && entry.weapon.refine ? Number(entry.weapon.refine) : null;
        var prev = prevRefineFor(entry.name, entry.score);
        // 识别层读不准时会给一个"候选"（颜色/OCR 单通道值，或图太小读不到时的提示），
        // 只用来提示，**绝不预选**——预选会被"应用"一键写进存档。
        var hint = entry.weapon && entry.weapon.hint ? Number(entry.weapon.hint) : null;
        var alt = entry.weapon && entry.weapon.alt ? Number(entry.weapon.alt) : null;
        var emptyLabel = "未识别";
        if (cur === null && prev) emptyLabel = "未识别（上次 " + prev + "）";
        else if (cur === null && hint) {
          emptyLabel = "未识别（识别候选 " + hint + (alt && alt !== hint ? " / " + alt : "") + "，请核对）";
        }
        box.appendChild(el("option", { value: "" }, emptyLabel));
        var pick = cur !== null ? cur : prev;
        for (var rn = 1; rn <= 5; rn++) {
          // 本次没读到、沿用上次的值时标出来，否则用户以为这次识别对了
          var op = el("option", { value: String(rn) },
            cur === null && prev === rn ? (rn + "阶（上次）") : (rn + "阶"));
          if (pick === rn) op.selected = true;
          box.appendChild(op);
        }
        line.appendChild(box);
        return { line: line, select: box };
      }
      function addCard(entry, isUnknown) {
        var c = byName[entry.name] || null;
        var card = el("div", { className: "mc-rv-card" + (isUnknown ? " unknown" : "") });
        if (isUnknown) {
          card.title = "这一行的分数读到了，但头像没匹配上任何角色（多半是图太小或该角色不在名录里）。" +
            "从下拉里选一个即可，不选就不应用。";
        }
        var av = el("div", { className: "mc-rv-av" });
        if (c && c.avatar) av.appendChild(el("img", { src: c.avatar, alt: "" }));
        else av.appendChild(el("div", { className: "empty", style: "font-size:10px;padding:4px" }, "?"));
        card.appendChild(av);
        var main = el("div", { className: "mc-rv-main" });
        var sel = el("select", { className: "mc-rv-select" });
        var opts = optionList(entry.name, entry.candidates);
        if (isUnknown) opts.unshift({ name: "", label: "? 未识别 · 请选一个角色" });
        opts.forEach(function (o) {
          var op = el("option", { value: o.name }, o.label);
          if (o.name === (entry.name || "")) op.selected = true;
          sel.appendChild(op);
        });
        main.appendChild(sel);
        var meta = el("div", { className: "mc-rv-meta" });
        if (isUnknown) meta.appendChild(el("span", null, "分数 " + (entry.score || "?") + "，头像没认出来"));
        else {
          meta.appendChild(el("span", null, entry.score === null || entry.score === undefined ? "无分数" : ("分数 " + Number(entry.score).toFixed(2))));
          if (entry.chain !== null && entry.chain !== undefined) meta.appendChild(el("span", null, entry.chain + "链"));
          // 字形 OCR 与角标颜色给的值不一致：链已按字形定案，但把颜色值也摆出来让用户核对
          if (entry.chain_disagree) {
            meta.appendChild(el("span", {
              title: "字形 OCR 与角标颜色判定不一致，已按字形（更可靠）取值"
                + (entry.chain_color !== undefined ? "；颜色判定为 " + entry.chain_color + " 链" : "")
                + (entry.chain_ocr ? "；OCR 读到「" + entry.chain_ocr + "」" : "")
            }, "链判据分歧"));
          }
          if (entry.name_issue) {
            meta.appendChild(el("span", {
              title: "头像复核（NCC）没通过：这一行可能不在名录里，或与相近角色混淆"
                + (entry.name_alt ? "；更像「" + entry.name_alt + "」" : "")
                + (entry.ncc !== undefined ? "（复核分 " + entry.ncc + "）" : "")
            }, "名字待核对"));
          }
          if (entry.chain_color_fixed) meta.appendChild(el("span", { title: "OCR 与角标颜色不一致，已按颜色修正" }, "链色校"));
          if (entry.weapon && entry.weapon.refine) meta.appendChild(el("span", null, "精" + entry.weapon.refine));
          if (entry.matches) meta.appendChild(el("span", null, "匹配 " + (Number(entry.matches) || 0).toFixed(1)));
        }
        main.appendChild(meta);
        // 把"识别时实际裁的那块图"摆出来：名字不确定看截图头像，精炼不确定看截图武器图标
        var shots = [];
        if (entry.avatar_crop) shots.push({ src: entry.avatar_crop, cap: "截图头像" });
        if (entry.weapon_crop) shots.push({ src: entry.weapon_crop, cap: "截图武器" });
        if (shots.length) {
          var shotWrap = el("div", { className: "mc-rv-shots" });
          shots.forEach(function (shot) {
            // 不叠文字、不叠阴影：截图本身就是图标，压字会挡住武器阶级/链角标
            var thumb = el("div", { className: "mc-rv-shot", title: shot.cap + " · 点击放大" });
            thumb.appendChild(el("img", { src: shot.src, alt: "" }));
            thumb.addEventListener("click", function (ev) {
              ev.stopPropagation();
              var light = el("div", { className: "mc-rv-zoom" });
              light.appendChild(el("img", { src: shot.src, alt: "" }));
              light.addEventListener("click", function () { light.remove(); });
              document.body.appendChild(light);
            });
            shotWrap.appendChild(thumb);
          });
          main.appendChild(shotWrap);
        }
        var chainLine = el("div", { className: "mc-rv-line" });
        chainLine.appendChild(el("span", null, "共鸣链"));
        var chainSel = el("select", { className: "mc-rv-chain" });
        var unknownOpt = el("option", { value: "" }, "链未识别");
        if (entry.chain === null || entry.chain === undefined) unknownOpt.selected = true;
        chainSel.appendChild(unknownOpt);
        for (var cn = 0; cn <= 6; cn++) {
          var cop = el("option", { value: String(cn) }, cn + "链");
          if (entry.chain === cn) cop.selected = true;
          chainSel.appendChild(cop);
        }
        chainLine.appendChild(chainSel);
        if (QUALITY[entry.name] === 5) main.appendChild(chainLine);
        var refineSel = null;
        if (showsWeaponRefine(entry.name)) {
          refineSel = buildRefineSelect(entry);
          main.appendChild(refineSel.line);
        }
        var lab = el("label", { className: "mc-rv-check" });
        var cb = el("input", { type: "checkbox" });
        cb.checked = !isUnknown;
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(" 应用"));
        main.appendChild(lab);
        card.appendChild(main);
        grid.appendChild(card);
        rows.push({ entry: entry, select: sel, chainSelect: chainSel,
          refineSelect: refineSel ? refineSel.select : null, checkbox: cb, unknown: !!isUnknown });
        sel.addEventListener("change", function () {
          var picked = byName[sel.value];
          if (picked && picked.avatar) {
            av.innerHTML = "";
            av.appendChild(el("img", { src: picked.avatar, alt: "" }));
          }
        });
      }
      chars.forEach(function (c) { addCard(c, false); });
      unknown.forEach(function (u) { addCard(u, true); });

      var foot = el("div", { className: "mc-review-foot" });
      foot.appendChild(el("div", { className: "hint" }, "高置信 " + autoChars.length + " 行会自动应用；下面只列需要确认的行。"));
      var cancel = el("button", { className: "btn" }, "取消");
      var apply = el("button", { className: "btn primary" }, "应用并覆盖拥有");
      cancel.addEventListener("click", function () { mask.remove(); });
      apply.addEventListener("click", function () {
        var picked = {};
        // 高置信行不再打扰用户，直接采用
        autoChars.forEach(function (c) {
          var local = byName[c.name];
          if (!local) return;
          picked[c.name] = Object.assign({}, c, { id: String(local.id), name: c.name });
        });
        rows.forEach(function (row) {
          if (!row.checkbox.checked) return;
          var name = row.select.value;
          if (!name) return;
          var c = byName[name];
          if (!c) return;
          var old = picked[name];
          var cur = Object.assign({}, row.entry, { id: String(c.id), name: name });
          cur.chain = row.chainSelect.value === "" ? null : Number(row.chainSelect.value);
          if (row.refineSelect) {
            var rv = row.refineSelect.value;
            cur.weapon = Object.assign({}, cur.weapon || {}, { refine: rv === "" ? null : Number(rv) });
          }
          if (!old || (cur.score || 0) > (old.score || 0)) picked[name] = cur;
        });
        var list = Object.keys(picked).map(function (k) { return picked[k]; });
        if (!list.length) { safeToast("没有可应用的角色", "warn"); return; }
        var modified = Object.assign({}, r, { characters: list, unknown_rows: [] });
        mask.remove();
        applyConfigResult(modified);
      });
      foot.appendChild(cancel);
      foot.appendChild(apply);
      panel.appendChild(foot);
      mask.appendChild(panel);
      document.body.appendChild(mask);
    } catch (e) {
      safeToast("结果确认页打开失败，直接应用：" + e, "warn");
      applyConfigResult(r);
    }
  }

  window.__MC_OPEN_CONFIG_REVIEW__ = openConfigReview;

  function applyConfigResult(r) {
    configBusy(false);
    if (!r || !r.ok) {
      safeToast("配置识别失败：" + (((r && r.errors) || [])[0] || "未知错误"), "error");
      return;
    }
    // 快照上一轮练度：本次没读到的字段要沿用旧值。
    // 低分辨率图（宽 <700px）的精炼必然为空，若无条件覆盖，重识别一次就把之前识别/手工修正的精炼全抹掉。
    var prevScores = configScores;
    // 练度识别 = 全量覆盖：先恢复默认角色/拥有、清空队伍和上一轮练度，再写本轮结果
    resetForNewRecognition();
    var matched = 0, ownedAdded = 0, keptRefine = 0;
    (r.characters || []).forEach(function (c) {
      if (!c) return;
      var localId = localCharIdForConfig(c);
      if (!localId) return;
      var w = c.weapon ? Object.assign({}, c.weapon) : null;
      var prev = prevScores[localId];
      // 沿用上一轮精炼的前提是"同一行"：分数必须一致。
      // 分数变了说明这一行是别的角色/练度变了，沿用会把别的角色的精炼挪过来
      // （实测踩过：折枝行是 0 链本该无精炼，却沿用了另一行的精5）。
      var sameRow = prev && prev.score !== null && prev.score !== undefined &&
        c.score !== null && c.score !== undefined &&
        Math.abs(Number(prev.score) - Number(c.score)) <= 0.01;
      if ((!w || !w.refine) && sameRow && prev.weapon && prev.weapon.refine) {
        w = Object.assign({}, w || {}, { refine: prev.weapon.refine, kept: true });
        keptRefine += 1;
      }
      configScores[localId] = { chain: c.chain, score: c.score, name: c.name, weapon: w };
      var localChar = state.characters.find(function (x) { return String(x.id) === String(localId); });
      if (localChar && !localChar.owned) { localChar.owned = true; ownedAdded += 1; }
      matched += 1;
    });
    // 拥有状态以本轮识别结果为准：只保留识别到的角色 + 默认四星/主角/默认五星，
    // 避免上一张图的旧五星（例如布兰特）残留在池子里。
    if ((r.characters || []).length >= 5) {
      var recognizedOwned = {};
      (r.characters || []).forEach(function (c) {
        var lid = localCharIdForConfig(c);
        if (lid) recognizedOwned[String(lid)] = true;
      });
      state.characters.forEach(function (c) {
        var next = isAlwaysOwned(c) || !!recognizedOwned[String(c.id)];
        if (c.owned !== next) { c.owned = next; ownedAdded += 1; }
      });
    }
    persistConfigScores();
    if (ownedAdded > 0) {
      if (typeof saveChars === "function") saveChars();
      if (typeof renderAll === "function") renderAll();
    } else if (window.renderTeams) {
      window.renderTeams();
    }
    if (typeof window.renderPool === "function") window.renderPool();
    if (typeof window.renderExhausted === "function") window.renderExhausted();
    var extra = r.unknown ? "，未识别 " + r.unknown + " 个" : "";
    // 图太小时精炼是空着的（低分辨率角标只有 8~9px），必须让用户知道原因，否则会以为识别坏了
    var lowRes = Number(r.unit) > 0 && Number(r.unit) < 23;
    if (lowRes) {
      extra += keptRefine
        ? "；图片偏小，武器精炼沿用上次的 " + keptRefine + " 个"
        : "；图片偏小，武器精炼未读取（建议宽 ≥700px）";
    } else if (keptRefine) {
      extra += "；" + keptRefine + " 个精炼沿用上次的值";
    }
    safeToast("配置识别完成：识别到 " + (r.characters || []).length + " 名，匹配 " + matched +
      " 名，新拥有 " + ownedAdded + " 名" + extra, lowRes ? "warn" : "info");
  }
  function runConfigRecognition(paths) {
    var api = window.pywebview && window.pywebview.api;
    if (!api || !api.recognize_config) { configBusy(false); safeToast("桌面桥接不可用，无法识别配置图", "error"); return; }
    if (!paths || !paths.length) { configBusy(false); return; }
    safeToast("正在识别配置图，角色多时可能需要十几秒…", "info");
    api.recognize_config(paths).then(openConfigReview).catch(function (e) {
      configBusy(false);
      safeToast("配置识别失败：" + e, "error");
    });
  }
  function recognizeConfig() {
    var api = window.pywebview && window.pywebview.api;
    if (!api || !api.pick_images) { safeToast("桌面桥接不可用，无法识别配置图", "error"); return; }
    configBusy(true);
    api.pick_images().then(function (paths) {
      if (!paths || !paths.length) { configBusy(false); return; }
      runConfigRecognition(paths);
    }).catch(function (e) { configBusy(false); safeToast("配置识别失败：" + e, "error"); });
  }
  function recognizeConfigClipboard() {
    var api = window.pywebview && window.pywebview.api;
    if (!api || !api.clipboard_image) { safeToast("桌面桥接不可用，无法读取剪贴板", "error"); return; }
    configBusy(true);
    api.clipboard_image().then(function (r) {
      if (!r || !r.ok || !r.path) {
        configBusy(false);
        safeToast((r && r.error) || "剪贴板里没有图片", "error");
        return;
      }
      runConfigRecognition([r.path]);
    }).catch(function (e) { configBusy(false); safeToast("读取剪贴板失败：" + e, "error"); });
  }

  function quickOrderRow(t, pos) {
    var row = el("div", { className: "mc-qrow", "data-sig": t.sig });
    row.appendChild(el("span", { className: "drag", title: "拖动排序" }, "⋮"));
    row.appendChild(el("span", { className: "num" }, String(t.idx + 1)));
    var avs = el("span", { className: "avs" });
    t.members.forEach(function (c) { if (c.avatar) avs.appendChild(el("img", { src: c.avatar, alt: "", draggable: "false" })); });
    row.appendChild(avs);
    var memberText = t.members.map(function (c) { return c.name; }).join(" / ");
    var names = teamNames[t.idx] ? teamDisplayName(t.idx) + " · " + memberText : memberText;
    row.appendChild(el("span", { className: "names", title: names }, names));
    if (teamDone && teamDone[t.sig]) row.appendChild(el("span", { className: "done-tag" }, "完成"));

    row.addEventListener("pointerdown", function (e) {
      if (window.Sortable) return;
      if (e.button !== 0 || (e.pointerType && e.pointerType === "touch")) return;
      if (e.target.closest("button")) return;
      e.preventDefault();
      var startX = e.clientX, startY = e.clientY, started = false, ghost = null, targetRow = null, before = false;
      var r0 = row.getBoundingClientRect(), offY = e.clientY - r0.top, pointerId = e.pointerId;

      function onMove(ev) {
        if (ev.pointerId !== pointerId) return;
        if (!started && Math.abs(ev.clientY - startY) < 4 && Math.abs(ev.clientX - startX) < 4) return;
        if (!started) {
          started = true;
          row.classList.add("dragging");
          ghost = row.cloneNode(true);
          ghost.classList.remove("dragging", "drop-before", "drop-after");
          ghost.classList.add("mc-qghost");
          ghost.style.width = r0.width + "px";
          ghost.style.left = Math.max(4, Math.min(window.innerWidth - 260, ev.clientX - 20)) + "px";
          ghost.style.top = (ev.clientY - offY) + "px";
          document.body.appendChild(ghost);
        }
        ev.preventDefault();
        ghost.style.left = Math.max(4, Math.min(window.innerWidth - 260, ev.clientX - 20)) + "px";
        ghost.style.top = (ev.clientY - offY) + "px";
        var body = document.getElementById("mcQuickOrderBody");
        if (body) {
          var br = body.getBoundingClientRect();
          if (ev.clientY < br.top + 40) body.scrollTop -= 14;
          else if (ev.clientY > br.bottom - 40) body.scrollTop += 14;
        }
        var under = document.elementFromPoint(ev.clientX, ev.clientY);
        var tr = under && under.closest ? under.closest(".mc-qrow") : null;
        if (tr === row) tr = null;
        if (tr) {
          var rr = tr.getBoundingClientRect();
          before = ev.clientX < rr.left + rr.width / 2;
          clearQuickHints();
          tr.classList.add(before ? "drop-before" : "drop-after");
          targetRow = tr;
        } else {
          clearQuickHints();
          targetRow = null;
        }
      }

      function finish(ev) {
        if (ev && ev.pointerId !== pointerId) return;
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerup", finish, true);
        document.removeEventListener("pointercancel", finish, true);
        row.classList.remove("dragging");
        clearQuickHints();
        if (ghost) { ghost.remove(); ghost = null; }
        if (!started || !targetRow) return;
        var targetSig = targetRow.getAttribute("data-sig");
        if (!targetSig || targetSig === t.sig) return;
        var order = matrixEnsure().order;
        var from = order.indexOf(t.sig);
        if (from < 0) return;
        order.splice(from, 1);
        var to = order.indexOf(targetSig);
        if (to < 0) return;
        if (!before) to += 1;
        order.splice(to, 0, t.sig);
        saveMatrix();
        renderQuickOrderRows();
      }

      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
    });
    return row;
  }
  function clearQuickHints() {
    Array.prototype.slice.call(document.querySelectorAll(".mc-qrow.drop-before,.mc-qrow.drop-after,.mc-qrow.dragging"))
      .forEach(function (el) { el.classList.remove("drop-before", "drop-after", "dragging"); });
  }
  function commitQuickOrder() {
    var body = document.getElementById("mcQuickOrderBody");
    if (!body) return;
    var sigs = Array.prototype.slice.call(body.querySelectorAll(".mc-qrow"))
      .map(function (r) { return r.getAttribute("data-sig"); }).filter(Boolean);
    if (!sigs.length) return;
    var m = matrixEnsure();
    m.order = sigs.concat(m.order.filter(function (s) { return sigs.indexOf(s) < 0; }));
    saveMatrix();
  }

  function initQuickSortable() {
    var body = document.getElementById("mcQuickOrderBody");
    if (!body) return;
    if (body._mcSortable) { try { body._mcSortable.destroy(); } catch (e) {} body._mcSortable = null; }
    if (!window.Sortable) return;
    body._mcSortable = new Sortable(body, {
      animation: 180,
      draggable: ".mc-qrow",
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      ghostClass: "mc-qrow-ghost",
      chosenClass: "mc-qrow-chosen",
      dragClass: "mc-qrow-drag",
      fallbackClass: "mc-qrow-fallback",
      swapThreshold: 0.65,
      invertSwap: false,
      scroll: true,
      scrollSensitivity: 60,
      scrollSpeed: 12,
      bubbleScroll: true,
      onStart: function () { document.body.classList.add("mc-sortable-dragging"); },
      onChange: function () { commitQuickOrder(); },
      onEnd: function () {
        document.body.classList.remove("mc-sortable-dragging");
        commitQuickOrder();
      }
    });
  }

  function renderQuickOrderRows() {
    var body = document.getElementById("mcQuickOrderBody");
    if (!body) return;
    body.innerHTML = "";
    var teams = matrixNonEmptyTeams();
    if (!teams.length) {
      body.appendChild(el("div", { className: "mc-qempty" }, "先在配队页组队，再来排序。"));
      return;
    }
    var bySig = {};
    teams.forEach(function (t) { bySig[t.sig] = t; });
    matrixEnsure().order.forEach(function (sig, pos) {
      var t = bySig[sig];
      if (t) body.appendChild(quickOrderRow(t, pos));
    });
    initQuickSortable();
  }
  function openQuickOrder() {
    if (document.getElementById("mcQuickOrderOverlay")) return;
    var overlay = el("div", { id: "mcQuickOrderOverlay" });
    var panel = el("div", { className: "mc-qorder" });
    var head = el("div", { className: "mc-qorder-head" });
    head.appendChild(el("span", { className: "title" }, "快速排队伍"));
    head.appendChild(el("span", { className: "sub" }, "拖动整行排序 · 同步配队页 / 矩阵页"));
    head.appendChild(el("span", { className: "sp" }));
    var byScore = el("button", { className: "btn sm" }, "按分数低→高");
    byScore.addEventListener("click", function () {
      var order = matrixEnsure().order;
      order.sort(function (a, b) { return (Number(matrix.scores[a]) || 0) - (Number(matrix.scores[b]) || 0); });
      saveMatrix(); renderQuickOrderRows();
    });
    var byNum = el("button", { className: "btn sm" }, "按队伍编号");
    byNum.addEventListener("click", function () {
      var teams = matrixNonEmptyTeams(); var order = matrixEnsure().order;
      order.sort(function (a, b) {
        var A = teams.filter(function (t) { return t.sig === a; })[0];
        var B = teams.filter(function (t) { return t.sig === b; })[0];
        return (A ? A.idx : 999) - (B ? B.idx : 999);
      });
      saveMatrix(); renderQuickOrderRows();
    });
    var close = el("button", { className: "btn sm primary" }, "完成");
    close.addEventListener("click", closeQuickOrder);
    head.appendChild(byScore); head.appendChild(byNum); head.appendChild(close);
    panel.appendChild(head);
    var body = el("div", { className: "mc-qorder-body", id: "mcQuickOrderBody" });
    panel.appendChild(body); overlay.appendChild(panel); document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeQuickOrder(); });
    renderQuickOrderRows();
  }
  function closeQuickOrder() {
    var overlay = document.getElementById("mcQuickOrderOverlay");
    if (overlay) overlay.remove();
    if (typeof window.renderTeams === "function") window.renderTeams();
    if (document.querySelector('.tab[data-tab="matrix"]') &&
        document.querySelector('.tab[data-tab="matrix"]').classList.contains("active")) {
      renderMatrixTeams(); renderMatrixBosses();
    }
  }

  function installMatrixTab() {
    if (document.getElementById("tab-matrix")) return;
    var tabs = document.querySelector(".tabs");
    var teamTab = document.querySelector('.tab[data-tab="team"]');
    if (tabs && teamTab && !document.querySelector('.tab[data-tab="matrix"]')) {
      var b = el("button", { className: "tab", "data-tab": "matrix" }, "矩阵");
      tabs.insertBefore(b, teamTab.nextSibling);
    }
    var teamSec = document.getElementById("tab-team");
    if (!teamSec) return;
    var sec = el("section", { className: "tabpane", id: "tab-matrix" });
    sec.innerHTML = '<div class="mc-matrix">' +
      '<div class="mc-matrix-top">' +
      '<div class="mc-rounds" id="mcMatrixRounds"></div>' +
      '<div class="mc-matrix-actions">' +
      '<button class="btn sm primary" id="mcMatrixChartBtn">生成伤害归属图</button>' +
      '<button class="btn sm" id="mcMatrixResetBtn">清空分数</button>' +
      '</div></div>' +
      '<div class="mc-matrix-layout">' +
      '<div class="mc-matrix-panel"><div class="mc-section-title">队伍顺序 <span class="sub">分数按这个顺序结算</span></div><div id="mcMatrixTeams"></div></div>' +
      '<div class="mc-matrix-panel"><div class="mc-section-title" id="mcMatrixRoundTitle">怪物 A–D 轮换 · 宝箱固定 <span class="sub">拖动血条交界可调分</span></div><div id="mcMatrixBosses"></div></div>' +
      '</div></div>';
    teamSec.insertAdjacentElement("afterend", sec);
    document.getElementById("mcMatrixChartBtn").addEventListener("click", openMatrixChart);
    document.getElementById("mcMatrixResetBtn").addEventListener("click", function () {
      var msg = "清空所有队伍的总分？队伍顺序保留。";
      var run = function () { matrixEnsure().scores = {}; saveMatrix(); renderMatrix(); };
      if (typeof showConfirm === "function") showConfirm(msg, run); else if (window.confirm(msg)) run();
    });
    renderMatrix();
  }


  /* ---------- 本期限时（左上角）---------- */
  var MATRIX_INFO = null;

  /** 左上角限时条：本期强化角色里「额外疲劳值」的点名出来。
   *  只在这期确实有这类角色时出现，平时不占地方。 */
  function installLimitedBanner(info) {
    if (document.getElementById("mcLimitedBanner")) return;
    var names = (info && info.stamina2_roles) || [];
    if (!names.length) return;
    var topbar = document.querySelector("header.topbar");
    if (!topbar) return;

    var bar = el("div", { className: "mc-limited", id: "mcLimitedBanner" });
    bar.appendChild(el("span", { className: "tag" }, "限时"));
    bar.appendChild(el("span", { className: "txt" },
      "第 " + info.period + " 期 · " + names.join("、") + " 额外疲劳值（2 点）"));

    var more = el("button", { className: "btn sm", type: "button" }, "查看本期 Buff");
    more.addEventListener("click", function () {
      var name = (document.querySelector(".tabs .tab.active") || {}).getAttribute;
      // 直接跳到矩阵页并滚到信息块
      var tab = document.querySelector('.tab[data-tab="matrix"]');
      if (tab) tab.click();
      setTimeout(function () {
        var panel = document.getElementById("mcMatrixInfo");
        if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 120);
    });
    bar.appendChild(more);
    topbar.appendChild(bar);
  }

  /** 矩阵页顶部的「本期阵容」块：关卡名 + Buff + 怪物 + 强化角色。 */
  function installMatrixInfoPanel(info) {
    if (document.getElementById("mcMatrixInfo")) return;
    var pane = document.getElementById("tab-matrix");
    if (!pane || !info) return;
    var host = pane.querySelector(".mc-matrix");
    if (!host) return;

    var wrap = el("div", { className: "panel mc-minfo", id: "mcMatrixInfo" });
    var title = "本期 · 第 " + info.period + " 期 " + (info.level_name || "");
    wrap.appendChild(el("div", { className: "panel-title" }, title));

    if (info.stamina2_roles && info.stamina2_roles.length) {
      var lim = el("div", { className: "mc-minfo-limited" });
      lim.appendChild(el("span", { className: "tag" }, "限时"));
      lim.appendChild(el("span", null, "额外疲劳值（2 点体力）：" + info.stamina2_roles.join("、")));
      wrap.appendChild(lim);
    }

    if (info.buffs && info.buffs.length) {
      wrap.appendChild(el("div", { className: "mc-minfo-head" }, "本期 Buff"));
      var bl = el("div", { className: "mc-minfo-list" });
      info.buffs.forEach(function (b) {
        var row = el("div", { className: "mc-minfo-row" });
        row.appendChild(el("span", { className: "nm" }, b.name));
        row.appendChild(el("span", { className: "ds" }, b.desc));
        bl.appendChild(row);
      });
      wrap.appendChild(bl);
    }

    if (info.bosses && info.bosses.length) {
      wrap.appendChild(el("div", { className: "mc-minfo-head" }, "怪物"));
      var wl = el("div", { className: "mc-boss-grid" });
      info.bosses.forEach(function (b) {
        var card = el("div", { className: "mc-boss-card" });

        var avatar = el("div", { className: "mc-boss-av" });
        if (b.icon) {
          // 服务端代理：本地有图就用本地的，没有再按官方 CDN 抓一次并缓存
          avatar.appendChild(el("img", { src: b.icon, alt: b.name, loading: "lazy" }));
        } else {
          avatar.appendChild(el("span", { className: "initial" }, (b.name || "?").charAt(0)));
        }
        card.appendChild(avatar);

        var body = el("div", { className: "mc-boss-body" });
        var head = el("div", { className: "mc-boss-name" }, b.name);
        if (b.rounds > 1) {
          head.appendChild(el("span", { className: "mc-boss-rounds" }, b.rounds + " 轮"));
        }
        body.appendChild(head);

        if (b.tags && b.tags.length) {
          var tagRow = el("div", { className: "mc-boss-tags" });
          b.tags.forEach(function (t) {
            var name = typeof t === "string" ? t : t.name;
            var color = typeof t === "string" ? "" : t.color;
            var chip = el("span", { className: "mc-boss-tag" }, name);
            if (color) {
              chip.style.color = color;
              chip.style.borderColor = color + "66";
              chip.style.background = color + "14";
            }
            tagRow.appendChild(chip);
          });
          body.appendChild(tagRow);
        }

        var notes = [];
        (b.desc || []).forEach(function (d) { if (d) notes.push(d); });
        (b.unlocked || []).forEach(function (d) { if (d) notes.push(d); });
        if (notes.length) {
          body.appendChild(el("div", { className: "mc-boss-desc" }, notes.join("\n")));
        }

        card.appendChild(body);
        wl.appendChild(card);
      });
      wrap.appendChild(wl);
    }

    if (info.roles && info.roles.length) {
      var details = el("details", { className: "mc-minfo-roles" });
      details.appendChild(el("summary", null, "本期强化角色（" + info.roles.length + "）"));
      var rl = el("div", { className: "mc-minfo-list" });
      info.roles.forEach(function (r) {
        var row = el("div", { className: "mc-minfo-row" });
        var nm = el("span", { className: "nm" }, r.name);
        if (info.stamina2_roles && info.stamina2_roles.indexOf(r.name) >= 0) {
          nm.appendChild(el("span", { className: "tag mini" }, "2点"));
        }
        row.appendChild(nm);
        row.appendChild(el("span", { className: "ds" }, r.desc));
        rl.appendChild(row);
      });
      details.appendChild(rl);
      wrap.appendChild(details);
    }

    var top = host.querySelector(".mc-matrix-top");
    if (top && top.parentNode) top.parentNode.insertBefore(wrap, top.nextSibling);
    else host.insertBefore(wrap, host.firstChild);
  }

  /* ---------- 启动 ---------- */
  /* 切换 Tab 时刷新矩阵：index.html 只切换 .active 类，
     矩阵内容是桌面版额外挂上去的，得自己监听点击。 */
  function installTabHooks() {
    if (document._mcTabHooked) return;
    document._mcTabHooked = true;
    document.addEventListener("click", function (e) {
      if (!e.target || !e.target.closest) return;
      var tabEl = e.target.closest(".tab");
      if (!tabEl) return;
      setTimeout(function () {
        var name = tabEl.getAttribute("data-tab");
        if (name === "matrix") {
          try { renderMatrix(); } catch (err) { console.error("renderMatrix failed", err); }
        }
        if (name === "rules") {
          try { installRulePriorityPanel(); } catch (err) { console.error(err); }
        }
        try { decorateRarity(); } catch (err) { /* 忽略 */ }
      }, 0);
    });
  }

  function boot() {
    injectStyle();
    installTabHooks();

    api("/bootstrap").then(function (data) {
      // 后端返回的不是「存档优先」而是「XWUID 角色表权威」：
      // 角色/练度永远来自面板数据，存档只带规则、方案、队伍排布这些用户编辑结果。
      if (!data.ok) {
        showBlocking(data.error || "数据加载失败，请按提示去群里准备数据");
        return;
      }

      var st = data.state || {};
      Object.keys(st).forEach(function (k) { deskStore[k] = st[k]; });
      window.__MC_DESKTOP_STORE__ = deskStore;

      if (st.mc_rule_mainc_priority) {
        maincPriority = st.mc_rule_mainc_priority.filter(function (x) { return typeof x === "string"; });
      }
      if (st.mc_rule_mainc_rule_order) maincRuleOrder = st.mc_rule_mainc_rule_order;
      if (st.mc_config_scores) configScores = st.mc_config_scores;
      if (st.mc_team_names) teamNames = st.mc_team_names;

      var serverChars = Array.isArray(data.characters) ? data.characters : [];
      var savedById = {};
      (Array.isArray(st.mc_characters) ? st.mc_characters : []).forEach(function (c) {
        if (c && c.id) savedById[String(c.id)] = c;
      });
      var bonusSet = {};
      ((data.matrix_info && data.matrix_info.stamina2_roles) || []).forEach(function (n) { bonusSet[n] = true; });

      mergedChars = serverChars.map(function (c) {
        var prev = savedById[String(c.id)] || {};
        // 体力点：后端值是权威（含固定 2 点角色 + 本期限时强化角色）。
        // 存档里可能还留着上一期的旧值，比如洛瑟菈上期是 1 点、这期变 2 点，
        // 若沿用存档就会把限时规则盖掉 —— 所以这里一律取后端，只有后端没给才回退存档。
        var stamina = typeof c.stamina === "number" ? c.stamina : prev.stamina;
        return {
          id: String(c.id),
          name: c.name,
          alias: c.alias || [],
          element: c.element || "",
          quality: c.quality,
          stamina: typeof stamina === "number" ? stamina : 1,
          owned: prev.owned === false ? false : true,
          // 头像是接口路径，不是 base64：几十人时体积差一个数量级
          avatar: "/waves/toolkit/api/avatar/" + encodeURIComponent(String(c.id)),
          // 以下来自 XWUID 官方评分接口，供卡片展示练度
          scoreBg: c.score_bg || "",
          score: typeof c.score === "number" ? c.score : null,
          chainName: c.chain_name || "",
          weaponReson: c.weapon_reson || 0,
          sonata: c.sonata || "",
        };
      });

      installBanner(data.user, data.account);

      // 本期矩阵信息（关卡 / Buff / 怪物 / 限时强化角色）——左上角限时条与矩阵页信息块都靠它
      if (data.matrix_info) {
        MATRIX_INFO = data.matrix_info;
        installLimitedBanner(MATRIX_INFO);
      }

      // 矩阵数据（9 轮 × 5 boss 的血量与换算系数）由后端提供
      if (data.matrix) setMatrixData(data.matrix);

      // 先让 index.html 按存档铺规则/队伍，再把角色表钉成后端给的权威值
      if (typeof window.loadFromStore === "function") {
        try {
          window.loadFromStore(null);
        } catch (e) {
          console.error("loadFromStore failed", e);
        }
      }
      if (mergedChars.length) {
        window.state.characters = mergedChars;
        rebuildConfigScores(serverChars);
        try { window.saveChars(); } catch (e) { /* 存档层不可用不影响显示 */ }
      }
      try { window.renderAll(); } catch (e) {
        console.error("renderAll failed", e);
        safeToast("界面载入异常：" + e.message, "error");
      }
      // 矩阵 Tab 与主C面板都依赖 state 已就绪，放在 renderAll 之后装
      try {
        installMatrixTab();
        // 信息块依赖 installMatrixTab 建出来的容器，必须排在它后面
        if (MATRIX_INFO) installMatrixInfoPanel(MATRIX_INFO);
        installRulePriorityPanel();
        decorateRarity();
      } catch (e) {
        console.error("panel install failed", e);
      }
      hookRenders();
      updateSaveState(null);
    }).catch(function (err) {
      safeToast("载入云端存档失败：" + err.message + "（已降级为本地模式）", "error");
      hookRenders();
    });
  }

  /* index.html 每次重绘后补上我们的装饰 */
  function hookRenders() {
    var origRenderAll = window.renderAll;
    if (typeof origRenderAll === "function" && !origRenderAll.__mcWebHook) {
      window.renderAll = function () {
        var ret = origRenderAll.apply(this, arguments);
        try {
          installRulePriorityPanel();
          decorateRarity();
          if (typeof window.__MC_RENDER_RULE_PRIORITY__ === "function") window.__MC_RENDER_RULE_PRIORITY__();
        } catch (e) { console.error("post-render hook failed", e); }
        return ret;
      };
      window.renderAll.__mcWebHook = true;
    }

    // 首次进入也补一遍
    try {
      installRulePriorityPanel();
      decorateRarity();
    } catch (e) { console.error("initial decorate failed", e); }
  }

  // index.html 是同步内联脚本，DOMContentLoaded 时它的 state 已就绪
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
