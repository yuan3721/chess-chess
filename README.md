# Online Chess · 在线国际象棋（纯前端）

一个**单文件、零依赖、离线可用**的在线国际象棋页面。双击 `index.html` 即可开始对弈，无需后端、数据库、登录或联网。

内置 **Stockfish 19 Lite（WebAssembly）**——本地人机对战 + 实时局面分析（胜率条 / 走法胜率），全部离线运行。

## 快速开始

```bash
# 方式一：直接双击打开（AI 与分析都开箱即用）
open index.html          # macOS
# 方式二：任意静态服务器
npx serve .              # 或 python3 -m http.server
```

## 功能

### 对战
- **双人对战**：同屏轮流走子
- **人机对战**：执白或执黑对 Stockfish，5 档难度（入门 ~1350 / 休闲 ~1700 / 进阶 ~2100 / 强手 ~2500 / 大师＝不限棋力），基于 UCI_Elo 精确限棋力
- AI 思考中锁定棋盘并在其玩家卡片显示“思考中…”；人机模式悔棋一次撤回“你的一次出手 + AI 应答”

### 实时分析（基于独立的引擎实例，与对弈引擎互不干扰）
- **左侧胜率条**：白方胜率高则白色占比多（含和棋各半计入）；将军杀 / 和棋终局自动定格为 100% / 50%
- **右侧“走法胜率”面板**：当前局面 Top-3 候选走法（MultiPV），每条显示 白胜·和棋·黑胜 三段概率条与百分比（UCI_ShowWDL 真实概率，非估算），随搜索深度实时刷新；引擎首选走法绿框标出
- 每步棋后约 0.5 秒内更新；无 WDL 数据的引擎可自动回退到 cp 评估换算

### 棋盘与规则
- 标准 8×8 棋盘，**SVG 棋子**（cburnett 经典样式，非 emoji），白方在下、支持翻转
- **两种走子方式**：鼠标 / 触屏拖拽（棋子跟随指针、合法点提示、非法位置红色禁止反馈、非法落子回弹 + 抖动）与 点击棋子 → 点击目标格
- **完整规则**（由 [chess.js](https://github.com/jhlywa/chess.js) 规则引擎驱动）：轮流走棋、王车易位、吃过路兵、兵升变（弹窗选择）、王不得走入攻击格、不得送王入将
- 自动判定：将军（王格红光提示）、将死、逼和（无子可动）、和棋（子力不足 / 三次重复 / 五十步）
- 界面提示：当前回合（上下玩家卡片 + 状态卡）、最近一步高亮、棋盘坐标 a1–h8、吃子与子力差
- 控制：悔棋、翻转棋盘、重新开始、新游戏（模式 / 难度 / 方向）、导出 PGN、复制 FEN
- 走子记录（1. e4 e5 … 成对显示，最新一步高亮）
- 响应式：桌面左右布局，≤920px 自动切换上下布局；触屏拖拽已适配

### 引擎的工作方式
- Stockfish 19 Lite **单线程** WASM（无需 SharedArrayBuffer / 特殊响应头，file:// 直接可用）
- wasm 以 base64 内嵌在 index.html 中，并**内嵌进 Worker 脚本前缀、接管 Worker 内的 fetch**——无论 glue 计算出什么加载地址都直接返回内嵌字节，因此双击打开、断网都能运行（不依赖 `fetch(blob:)`，该调用在部分浏览器的 file:// Worker 中不受支持）
- 对弈引擎：`UCI_LimitStrength`/`UCI_Elo` 控棋力，`go movetime` 控响应时间（0.25–1 秒）
- 分析引擎：独立实例，`MultiPV 3` + `UCI_ShowWDL` + 500ms 搜索
- 代际号（epoch / token）机制：重开 / 悔棋 / 局面变化时自动丢弃在途结果，避免错乱

## 项目结构

```
index.html          ← 交付物：单文件成品（约 2.4MB，含引擎），直接打开即玩
src/
  shell.html        页面骨架（含占位标记）
  style.css         样式（深色主题、响应式、动画）
  app.js            应用逻辑（模块化：Game / Engine / Analysis / BoardView / …）
vendor/
  chess.js          chess.js 0.13.4（BSD-2-Clause，走法规则）
  pieces/*.svg      cburnett 棋子 12 枚（CC-BY-SA 3.0，via lichess）
  engine/           Stockfish 19 Lite WASM 单线程版（GPLv3）
tools/
  build.mjs         构建脚本：把 src/ + vendor/ 内联成 index.html
```

### 二次开发

日常修改可直接编辑 `index.html`；若以 `src/` 为源头维护，改完运行：

```bash
node tools/build.mjs   # 无需安装任何依赖
```

### 代码结构（为扩展而设计）

`app.js` 内各模块职责单一、接口清晰：

| 模块 | 职责 | 扩展接入点 |
|---|---|---|
| `Game` | chess.js 封装：合法走法 / 状态判定 / FEN / PGN | 棋谱导入直接复用 |
| `Engine` | Stockfish Worker 封装（init / think / analyze / cancel） | 换引擎、调强度只改这里 |
| `Analysis` | 胜率条 + 走法胜率（MultiPV + WDL 解析，独立引擎实例） | 加评估曲线、更深分析 |
| `BoardView` | 渲染 + 拖拽/点击交互 + 高亮 | 换皮、坐标标注 |
| `App` | 流程控制，`requestMove` 是唯一走子入口 | 在线对战接 WebSocket 时把远端走子喂给 `executeMove` |

页面还暴露了控制台 API（供自动化测试 / 二次开发）：

```js
chessApp.api.move('e2', 'e4')        // 走子（升变默认后，可传第三参 'q'|'r'|'b'|'n'）
chessApp.api.undo() / .reset() / .flip()
chessApp.api.fen() / .pgn() / .loadFen(fen)
chessApp.api.status()                // { code: 'check'|'checkmate'|'stalemate'|... }
chessApp.ai.info()                   // { mode, level, thinking, booted }
chessApp.ai.think(fen, level)        // 直接询问引擎（调试用）
```

## 后续路线（结构已预留）

- 在线匹配 / WebSocket 对战：走子入口收敛于 `requestMove`，远端走子同样调用 `executeMove`
- 棋谱导入：chess.js 自带 `load_pgn`，加一个导入按钮即可
- 计时器：玩家卡片（`PlayerCards`）已留出徽标位
- 更强引擎：`vendor/engine/` 换完整版 Stockfish wasm（约 95MB，需本地服务器加载）

## 已验证

- 规则：将死 / 逼和 / 三次重复 / 子力不足 / 五十步 / 王车易位（长短翼）/ 吃过路兵 / 升变（含吃子升变）/ 非法走法拒绝
- 交互：鼠标拖拽、触屏拖拽、点击-点击、二次点击取消选中、非法回弹与红色反馈、升变弹窗
- AI：file:// 离线启动（fetch 接管方案）、执白/执黑、5 档难度、思考中锁盘、悔棋语义、思考中途重开（代际丢弃）、升变解析、移动端视口
- 分析：胜率条随局面更新 / 将死定格 100% / 和棋 50%；走法胜率 Top-3 实时刷新（初始局面 e4/Nf3/d4）；悔棋后自动重析；与对弈引擎并行运行
- 布局：桌面双列 / 移动端单列（390px 视口实测）、无横向溢出、全程控制台零报错

## 许可

- [chess.js](https://github.com/jhlywa/chess.js) 0.13.4 — BSD-2-Clause，© Jeff Hlywa
- [Stockfish 19 Lite WASM](https://github.com/nmrugg/stockfish.js)（含 sszg13 训练的网络）— **GPLv3**，© Stockfish 开发者；经 nmrugg/stockfish.js 构建
- 棋子 SVG（cburnett）— Colin M.L. Burnett，CC-BY-SA 3.0，经由 lichess 分发
- 本项目其余代码可自由使用
