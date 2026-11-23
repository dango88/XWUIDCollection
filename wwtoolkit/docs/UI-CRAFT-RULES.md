# 让 UI 不「死板」——可直接落地的规则集

> 来源（GitHub 实地调研）：
> - **emilkowalski/skills**（★58.7k，Sonner / Vaul 作者）——`ui-cheatsheet.md`、`skills/emil-design-eng`、`skills/choreograph`、`skills/find-animation-opportunities`、`performance-cheatsheet.md`
> - **Nutlope/hallmark**（★59k，Together AI）——`skills/hallmark/SKILL.md` 的「Floor」硬约束与 slop 检查清单
> - **AThevon/genjutsu**（★823）——anti-AI-slop 的动效/微交互主张
> 结论：所谓「死板」不是缺动画，而是**层次与反馈**缺失。下面按「先修层次 → 再修手感 → 最后动效」三段给出。

---

## 一、为什么会显得死板（诊断清单）

| 症状 | 根因 | 修法 |
|---|---|---|
| 整屏像一块板 | 面板与背景亮度差 < 5% | 建立 4 级明度阶梯，相邻差 ≥ 4% |
| 卡片浮不起来 | 没有描边/阴影，或圆角混用 | 统一圆角 + `1px` 描边 + 极轻阴影 |
| 点击没反馈 | 只在 `:hover` 变色，没有 `:active` | `:active{transform:scale(.97)}` 100–160ms |
| 弹层「突然出现」 | 无 origin、无位移 | `opacity + translateY(-4px)`，`transform-origin` 指触发点 |
| 数字跳动时抖 | 非等宽数字 | `font-variant-numeric:tabular-nums` |
| 过渡「拖沓」 | 用了 `ease-in` / `transition:all` / >300ms | 全部换 `ease-out` + 具体属性 + ≤250ms |
| 卡片内容挤 | 网格轨道塌陷（`grid-template-rows` 固定但卡片更高） | `grid-auto-rows:max-content` 或去掉 `aspect-ratio` |

---

## 二、层次（Hierarchy）——这是「不死板」的第一性

**明度阶梯（深色）**
```css
--bg:#0a0e12;      /* 页面底 */
--panel:#121a22;   /* 一级面板：侧栏、内容区 */
--panel2:#18222c;  /* 二级：卡片 */
--panel3:#1e2a35;  /* 三级：卡片内嵌块（槽位、输入框） */
```
**明度阶梯（浅色）**
```css
--bg:#e6e9e8;--panel:#fdfdfb;--panel2:#f6f7f4;--panel3:#eceeea;
```
**浮起三件套**（每张卡片都要，缺一个就「贴平」）
```css
.card{
  border:1px solid var(--line);                 /* 边界 */
  border-radius:6px;                            /* 统一圆角 */
  box-shadow:0 1px 2px rgba(0,0,0,.06);         /* 极轻投影 */
  background:var(--panel2);
}
/* 深色模式加内高光，模拟材质受光 */
html[data-theme="dark"] .card{box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 1px 2px rgba(0,0,0,.4)}
```

**材质（Apple 的做法，用在导航条/抽屉/气泡）**
```css
.glass{
  background:rgba(255,255,255,.62);            /* 深色: rgba(10,13,18,.62) */
  backdrop-filter:blur(20px) saturate(180%);
  border-top:1px solid rgba(255,255,255,.4);   /* 上沿受光 */
}
```
规则：**不要让半透明层再叠半透明层**（可读性崩）；大面板 blur 更强、阴影更深；小 chip 用轻 blur。

---

## 三、反馈（Feedback）——每个交互都必须有

| 元素 | `:hover` | `:active` | 时长/曲线 |
|---|---|---|---|
| 按钮 | 背景 +6% 亮度 / 描边变强调 | `scale(.97)` | 120ms `cubic-bezier(.23,1,.32,1)` |
| 卡片 | `translateY(-1px)` + 阴影加深 | `scale(.995)` | 160ms ease-out |
| chip | 描边变强调 + 文字变强调 | `scale(.97)` | 120ms |
| 下拉/输入 | 描边变强调 | — | 140ms |
| 可拖拽 | `cursor:grab`，悬停显示把手 | 拖拽中 `opacity:.6;scale(1.02)` | 即时 |
| 槽位落点 | 描边变强调 + 背景微亮 | — | 即时 |

**重点**：按下反馈要在 `pointerdown` 就出现，不要等 `click`（等 click 会「感觉死了」）。

---

## 四、动效（只在 8 个时刻加）

| 时刻 | 动画 | 参数 |
|---|---|---|
| 气泡/下拉出现 | `opacity 0→1` + `translateY(-4px)→0` | 150–200ms `cubic-bezier(.23,1,.32,1)`；退出快 30% |
| 弹窗 | `opacity` + `scale(.96→1)`（**不要 scale(0)**） | 180–220ms |
| 抽屉 | `translateX(-100%)→0` | 220–280ms `cubic-bezier(.32,.72,0,1)` |
| toast | `translateY(8px)` + 淡入 | 200ms 进 / 150ms 出 |
| 主题切换 | 只过渡 `background-color`/`color` | 180ms ease（避免亮度突跳） |
| 角色放入 | 槽位描边闪一次 + 成员卡 `scale(.98→1)` | 160ms |
| 拖拽落位 | 落点描边高亮，悬浮元素跟随指针 1:1 | 即时（无过渡） |
| 元素进入视口（仅首次） | `opacity` + `translateY(6px)` | 220ms，最多错开 3 个（每级 +40ms） |

**禁止清单（hallmark Floor + emil 的硬规则）**
- ❌ `transition: all`（改用 `transition:transform 160ms var(--ease-out), border-color 160ms var(--ease-out)`）
- ❌ `ease-in`（UI 里一律 `ease-out` 或自定义曲线）
- ❌ 动画 `width` / `height` / `top` / `left`（只动 `transform` / `opacity`）
- ❌ `scale(0)` 作为进入起点
- ❌ UI 元素动效 > 300ms（弹层/抽屉/Toast 例外，≤500ms）
- ❌ 高频列表做逐项 stagger
- ❌ 键盘触发路径加动画
- ❌ 紫色到蓝色渐变、卡中卡、emoji 当图标
- ❌ 没有 `prefers-reduced-motion` 兜底

**必须的兜底**
```css
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
}
@media (prefers-reduced-transparency:reduce){ .glass{background:var(--panel);backdrop-filter:none} }
```

---

## 五、排版与数字（成本最低、观感提升最大）

```css
/* 所有数字/分数/时间/计数 */
.num{font-variant-numeric:tabular-nums}
/* 大标题收紧字距 */
h1,.title{letter-spacing:-0.02em}
/* 正文行长 */
p,.desc{max-width:65ch}
/* 小标签不要用全大写+字距（hallmark 明确列为 AI 味） */
.label{font-size:11px;letter-spacing:0;text-transform:none;color:var(--muted)}
/* 图标与文字基线对齐 */
.icon{vertical-align:-0.125em;flex-shrink:0}
```

**清单式「AI 味」自查**（hallmark Floor，逐条对照）
1. 每个颜色/字体都走 token，没有裸色值
2. 没有 `transition:all`
3. 标题里没有斜体单词
4. `html,body{overflow-x:clip}`（不是 hidden / 100vw）
5. 图片网格轨道用 `minmax(0,1fr)`
6. 每个可交互元素有 `:focus-visible`（即时出现）
7. 每个动画有 `prefers-reduced-motion` 兜底
8. 没有编造的指标/数字
9. 没有「标题上方的小 eyebrow 标签」、没有全大写字距标签
10. 没有中点连接的元信息串（`A · B · C`）、没有粘在链接上的箭头、没有装饰性状态圆点
11. 没有紫蓝渐变、没有卡中卡、没有 emoji 图标
12. 首屏核心内容 1280×800 不用滚
13. 一屏文字约 80 词
14. 1920 宽度下只加外边距，不加内容宽度

> 说明：第 10/11 条与本项目现有设计有冲突（我们确实用了 `A · B · C` 元信息串与装饰圆点，且这是游戏 UI 的常见语汇）。**这两条按我们自己的规范执行，不照抄**——但要保证它们是**有功能含义**的（如元素色点代表属性），而不是纯装饰。

---

## 六、落到本项目的最小改动集

1. `--bg/--panel/--panel2/--panel3` 四级明度（相邻 ≥ 4%）
2. 所有卡片统一：`radius 6px` + `1px var(--line)` + `0 1px 2px` 极轻阴影
3. 所有按钮/chip 加 `:active{transform:scale(.97)}`（120ms）
4. 所有弹层/气泡：`opacity + translateY(-4px)` 200ms，`transform-origin` 指触发点；退出 150ms
5. 抽屉：`translateX` 260ms `cubic-bezier(.32,.72,0,1)`
6. 全部 `transition:all` → 具体属性；`ease-in` → `ease-out`
7. 数字统一 `tabular-nums`
8. 补 `prefers-reduced-motion` / `prefers-reduced-transparency` 兜底