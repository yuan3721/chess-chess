/* ============================================================
 * Online Chess — 应用逻辑
 *
 * 模块划分（便于后续扩展在线匹配 / PGN 导入 / 计时器）：
 *   Game            规则引擎封装（chess.js，负责全部走法合法性判断）
 *   Engine          Stockfish WASM 引擎封装（UCI over Worker，人机对战）
 *   BoardView       棋盘渲染、拖拽 + 点击两种走子方式、各类高亮
 *   MoveList        走子记录（1. e4 e5 成对渲染）
 *   StatusPanel     当前回合 / 游戏状态 / 步数 / 最近一步
 *   PlayerCards     上下玩家卡片（回合提示、吃子、子力差、AI 思考状态）
 *   PromotionDialog 兵升变选择弹窗
 *   NewGameDialog   新游戏（双人 / 人机执白 / 人机执黑 + AI 难度）
 *   Banner          对局结束横幅
 *   App             组装与流程控制，暴露 window.chessApp 控制台 API
 *
 * 全部状态以 Game(chess.js) 为唯一事实来源，UI 只是它的投影。
 * ============================================================ */

(() => {
  'use strict';

  /* ---------- 常量与工具 ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);

  const FILES = 'abcdefgh';
  const PIECE_ZH = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };
  const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const PROMO_ORDER = ['q', 'n', 'r', 'b'];

  /** AI 难度档位：UCI_Elo 限棋力 + movetime 控制响应速度；大师档不限棋力 */
  const AI_LEVELS = [
    { name: '入门', elo: 1350, movetime: 250 },
    { name: '休闲', elo: 1700, movetime: 400 },
    { name: '进阶', elo: 2100, movetime: 600 },
    { name: '强手', elo: 2500, movetime: 800 },
    { name: '大师', unlimited: true, movetime: 1000 },
  ];

  const other = (c) => (c === 'w' ? 'b' : 'w');
  const colorName = (c) => (c === 'w' ? '白方' : '黑方');
  const fileIdx = (sq) => FILES.indexOf(sq[0]);
  const rankIdx = (sq) => Number(sq[1]) - 1;
  const sqAt = (f, r) => FILES[f] + (r + 1);
  const isSquare = (sq) => /^[a-h][1-8]$/.test(sq);

  /* ---------- Game：规则引擎封装 ---------- */
  class Game {
    constructor() { this.reset(); }

    reset() { this.chess = new Chess(); this.baseFen = null; }

    turn() { return this.chess.turn(); }
    fen() { return this.chess.fen(); }

    pieceAt(sq) { const p = this.chess.get(sq); return p || null; }

    /** 某格棋子的所有合法走法（verbose：含 to / flags / san / captured…） */
    legalMoves(sq) {
      if (!isSquare(sq)) return [];
      return this.chess.moves({ square: sq, verbose: true });
    }

    isLegal(from, to) { return this.legalMoves(from).some((m) => m.to === to); }

    /** from→to 是否是需要选择升变棋子的走法 */
    isPromotion(from, to) {
      return this.legalMoves(from).some((m) => m.to === to && m.flags.includes('p'));
    }

    /** 执行走法；非法返回 null */
    move({ from, to, promotion }) {
      return this.chess.move({ from, to, promotion: promotion || undefined }) || null;
    }

    undo() { return this.chess.undo(); }

    history() { return this.chess.history({ verbose: true }); }

    pgnBody() { return this.chess.pgn({ max_width: 80, newline_char: '\n' }); }

    loadFen(fen) {
      const ok = this.chess.load(fen);
      if (ok) this.baseFen = fen;      // 回放基点 = 载入的局面
      return ok;
    }

    /** 指定颜色王的所在格 */
    kingSquare(color) {
      const board = this.chess.board();
      for (let ri = 0; ri < 8; ri++) {
        for (let fi = 0; fi < 8; fi++) {
          const p = board[ri][fi];
          if (p && p.type === 'k' && p.color === color) return sqAt(fi, 7 - ri);
        }
      }
      return null;
    }

    /** PGN 棋谱导入（宽容模式）；失败返回 false */
    loadPgn(text) {
      let ok = false;
      try { ok = !!this.chess.load_pgn(text, { sloppy: true }); } catch { ok = false; }
      if (!ok) return false;
      // 带 SetUp/FEN 头的棋谱：回放基点为该 FEN，而非标准初始局面
      const h = this.chess.header();
      this.baseFen = (h && h.SetUp === '1' && typeof h.FEN === 'string') ? h.FEN : null;
      return true;
    }

    /** 读取 PGN 头信息（White / Black / Event …） */
    header(name) {
      try {
        const h = this.chess.header();
        return (h && typeof h[name] === 'string') ? h[name] : '';
      } catch { return ''; }
    }

    setHeader(name, value) { this.chess.header(name, value); }

    /** 截断棋局：丢弃第 ply 步之后的所有走法（用于回看分叉） */
    truncateTo(ply) {
      const n = this.chess.history().length;
      for (let i = ply; i < n; i++) this.chess.undo();
    }

    /** 回放得到第 ply 步（0..n）之后的只读局面；ply === n 时即当前局面 */
    boardAt(ply) {
      const hist = this.history();
      const k = Math.max(0, Math.min(ply, hist.length));
      if (k === hist.length) return this.chess;
      const c = this.baseFen ? new Chess(this.baseFen) : new Chess();
      for (let i = 0; i < k; i++) {
        const h = hist[i];
        c.move({ from: h.from, to: h.to, promotion: h.promotion || undefined });
      }
      return c;
    }

    /** 当前局面 → { square: 'wK' … } 棋子映射（编辑器用） */
    mapPieces() { return mapFromBoard(this.chess); }

    /** 综合局面状态（有序判定：将死 > 逼和 > 子力不足 > 三次重复 > 五十步 > 将军） */
    status() { return computeStatus(this.chess); }
  }

  /** 对任意 chess.js 实例计算局面状态（回看历史局面时复用） */
  function computeStatus(c) {    if (c.in_checkmate()) {
        const winner = other(c.turn());
        return {
          code: 'checkmate', over: true, winner,
          text: `将死 · ${colorName(winner)}获胜`,
          bannerTitle: `${colorName(winner)}获胜`,
          bannerSub: '将死 Checkmate',
          result: winner === 'w' ? '1-0' : '0-1',
        };
      }
      if (c.in_stalemate()) {
        return { code: 'stalemate', over: true, text: '和棋 · 逼和（无子可动）',
          bannerTitle: '和棋', bannerSub: '逼和 · 无子可动 Stalemate', result: '1/2-1/2' };
      }
      if (c.insufficient_material()) {
        return { code: 'material', over: true, text: '和棋 · 子力不足',
          bannerTitle: '和棋', bannerSub: '双方子力不足以将死 Insufficient material', result: '1/2-1/2' };
      }
      if (c.in_threefold_repetition()) {
        return { code: 'threefold', over: true, text: '和棋 · 三次重复局面',
          bannerTitle: '和棋', bannerSub: '三次重复局面 Threefold repetition', result: '1/2-1/2' };
      }
      if (c.in_draw()) {
        return { code: 'fifty', over: true, text: '和棋 · 五十步规则',
          bannerTitle: '和棋', bannerSub: '连续五十步无吃子、无兵动 Fifty-move rule', result: '1/2-1/2' };
      }
      if (c.in_check()) {
        return { code: 'check', over: false, text: '将军！', bannerTitle: '', bannerSub: '', result: '*' };
      }
      return { code: 'normal', over: false, text: '进行中', bannerTitle: '', bannerSub: '', result: '*' };
  }

  /* ---------- 局面编辑器工具 ---------- */
  /** chess.js 实例 → { square: 'wK' } 棋子映射 */
  function mapFromBoard(c) {
    const map = {};
    const b = c.board();
    for (let ri = 0; ri < 8; ri++) {
      for (let fi = 0; fi < 8; fi++) {
        const p = b[ri][fi];
        if (p) map[sqAt(fi, 7 - ri)] = p.color + p.type.toUpperCase();
      }
    }
    return map;
  }

  /** 棋子映射 + 行棋方 → FEN（易位权按王车位置自动推导，过路兵清空） */
  function fenFromMap(map, turn) {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const code = map[sqAt(f, r)];
        if (!code) { empty++; continue; }
        if (empty) { row += String(empty); empty = 0; }
        row += code[0] === 'w' ? code[1] : code[1].toLowerCase();
      }
      if (empty) row += String(empty);
      rows.push(row);
    }
    let cast = '';
    if (map.e1 === 'wK') { if (map.h1 === 'wR') cast += 'K'; if (map.a1 === 'wR') cast += 'Q'; }
    if (map.e8 === 'bK') { if (map.h8 === 'bR') cast += 'k'; if (map.a8 === 'bR') cast += 'q'; }
    return `${rows.join('/')} ${turn} ${cast || '-'} - 0 1`;
  }

  /** 宽容解析 FEN：允许省略后半字段，补全为标准默认值 */
  function normalizeFen(text) {
    const parts = String(text).trim().split(/\s+/);
    if (parts.length < 1 || !parts[0].includes('/')) return null;
    const full = [parts[0], parts[1] === 'w' || parts[1] === 'b' ? parts[1] : 'w',
      parts[2] || '-', parts[3] || '-', parts[4] || '0', parts[5] || '1'];
    const fen = full.join(' ');
    const c = new Chess();
    try { return c.load(fen) ? fen : null; } catch { return null; }
  }

  /* ---------- Engine：Stockfish WASM 引擎封装 ----------
   * 引擎以 base64 内嵌于本文件（ENGINE_GLUE / ENGINE_WASM_B64，由构建脚本注入），
   * Worker 脚本前缀内嵌 wasm 字节并接管 fetch —— 无论 glue 计算出什么加载地址，
   * 都直接返回内嵌字节，因此双击 file:// 打开也能离线运行
   * （不依赖 fetch(blob:)，该调用在部分浏览器的 file:// Worker 中不受支持）。
   * 通信协议为 UCI：uci/uciok、isready/readyok、position、go、bestmove、setoption。
   */
  class Engine {
    constructor() {
      this.worker = null;
      this.ready = false;
      this.initPromise = null;
      this._resolveInit = null;
      this._rejectInit = null;
      this._initTimer = null;
      this._pending = null;      // 等待 bestmove 的 resolve
      this._pendingInfo = null;  // 分析模式下的 info 行回调
    }

    /** 首次使用时启动引擎（约 1~2 秒），失败时允许重试 */
    init() {
      if (this.initPromise) return this.initPromise;
      this.initPromise = new Promise((resolve, reject) => {
        let worker;
        try {
          // 引擎脚本前缀：把 wasm 字节内嵌进 Worker，并接管 Worker 内的 fetch
          const prefix =
            'var __B64=' + JSON.stringify(ENGINE_WASM_B64) + ';' +
            'var __WASM_BYTES=null;' +
            'self.fetch=function(){' +
            'if(!__WASM_BYTES){__WASM_BYTES=Uint8Array.from(atob(__B64),function(c){return c.charCodeAt(0);});}' +
            'return Promise.resolve(new Response(__WASM_BYTES,{headers:{"Content-Type":"application/wasm"}}));' +
            '};\n';
          const glueURL = URL.createObjectURL(new Blob([prefix + ENGINE_GLUE], { type: 'text/javascript' }));
          worker = new Worker(glueURL);
        } catch (err) {
          reject(err);
          return;
        }
        this.worker = worker;
        this._resolveInit = resolve;
        this._rejectInit = reject;
        this._initTimer = setTimeout(() => reject(new Error('引擎启动超时')), 20000);
        worker.onerror = (e) => {
          clearTimeout(this._initTimer);
          reject(new Error('引擎加载失败: ' + (e.message || '未知错误')));
        };
        worker.onmessage = (e) => this._onMessage(e.data);
        worker.postMessage('uci');
      }).catch((err) => {
        this.initPromise = null;          // 失败后清理，允许下次重试
        throw err;
      });
      return this.initPromise;
    }

    _onMessage(msg) {
      if (typeof msg !== 'string') return;
      if (msg === 'uciok') {
        this._send('isready');
      } else if (msg === 'readyok') {
        if (this._resolveInit) {
          clearTimeout(this._initTimer);
          this.ready = true;
          const r = this._resolveInit;
          this._resolveInit = this._rejectInit = null;
          r();
        }
      } else if (msg.startsWith('info ') && this._pendingInfo) {
        this._pendingInfo(msg);
      } else if (msg.startsWith('bestmove')) {
        const r = this._pending;
        this._pending = null;
        this._pendingInfo = null;
        if (r) r(this._parseBestmove(msg));
      }
      // 其余 id … 等行忽略
    }

    _send(cmd) { if (this.worker) this.worker.postMessage(cmd); }
    _setOption(name, value) { this._send(`setoption name ${name} value ${value}`); }

    newGame() { this._send('ucinewgame'); this._send('isready'); }

    /** 停止当前搜索（引擎会很快给出 bestmove，结果由调用方按代际丢弃） */
    cancel() { this._send('stop'); }

    /**
     * 思考并返回走法 {from, to, promotion?}
     * @param fen   当前局面
     * @param level AI_LEVELS 档位
     */
    async think(fen, level) {
      await this.init();
      this._setOption('UCI_LimitStrength', level.unlimited ? 'false' : 'true');
      if (!level.unlimited) this._setOption('UCI_Elo', String(level.elo));
      this._send(`position fen ${fen}`);
      return new Promise((resolve, reject) => {
        this._pending = resolve;
        this._send(`go movetime ${level.movetime}`);
        setTimeout(() => {
          if (this._pending === resolve) {
            this._pending = null;
            reject(new Error('引擎思考超时'));
          }
        }, level.movetime + 15000);
      });
    }

    /**
     * 后台分析当前局面（MultiPV + WDL）。
     * onInfo 逐行接收 info 行（实时更新胜率），bestmove 后 resolve。
     */
    async analyze(fen, { multiPV = 3, movetime = 500 } = {}, onInfo = () => {}) {
      await this.init();
      this._setOption('UCI_LimitStrength', 'false');
      this._setOption('MultiPV', String(multiPV));
      this._setOption('UCI_ShowWDL', 'true');
      this._send(`position fen ${fen}`);
      return new Promise((resolve, reject) => {
        this._pendingInfo = onInfo;
        this._pending = resolve;
        this._send(`go movetime ${movetime}`);
        setTimeout(() => {
          if (this._pending === resolve) {
            this._pending = null;
            this._pendingInfo = null;
            this._send('stop');
            reject(new Error('分析超时'));
          }
        }, movetime + 8000);
      });
    }

    _parseBestmove(line) {
      const m = line.match(/^bestmove\s+([a-h][1-8])([a-h][1-8])([qrbn])?/);
      if (!m) return null;
      return { from: m[1], to: m[2], promotion: m[3] || undefined };
    }
  }

  /** 解析 UCI info 行 → {depth, multipv, cp?, mate?, wdl?[W,D,L], pv:[uci…]} */
  function parseInfoLine(line) {
    if (!line.startsWith('info ')) return null;
    const t = line.split(/\s+/);
    const out = { pv: [] };
    for (let i = 1; i < t.length; i++) {
      const k = t[i];
      if (k === 'depth') out.depth = Number(t[++i]);
      else if (k === 'multipv') out.multipv = Number(t[++i]);
      else if (k === 'score') {
        const type = t[++i];
        if (type === 'cp') out.cp = Number(t[++i]);
        else if (type === 'mate') out.mate = Number(t[++i]);
        const nx = t[i + 1];
        if (nx === 'lowerbound' || nx === 'upperbound') i++;
      } else if (k === 'wdl') {
        out.wdl = [Number(t[++i]), Number(t[++i]), Number(t[++i])];
      } else if (k === 'pv') {
        out.pv = t.slice(i + 1);
        break;
      }
    }
    return out.pv.length ? out : null;
  }

  /* ---------- Analysis：局面分析（胜率条 + 走法胜率面板） ----------
   * 使用独立的分析引擎实例（与对弈引擎互不干扰），每次局面变化后台
   * 分析当前局面（MultiPV=3、UCI_ShowWDL），把每个候选走法的
   * 胜/和/负 千分比换算成白方视角并驱动 UI。
   */
  class Analysis {
    /** ui: { bar(share), meta(text), moves(records, st) } */
    constructor(ui) {
      this.ui = ui;
      this.engine = null;
      this.token = 0;
      this.timer = null;
      this.inflight = null;
      this.lastFen = null;
      this._records = {};
      this._depth = 0;
      this.scratch = new Chess();
    }

    /** 局面变化入口（App.refresh 调用）；fen 未变则跳过，终局直接定格 */
    setPosition(fen, st) {
      if (fen === this.lastFen) return;
      this.lastFen = fen;
      this.token++;
      clearTimeout(this.timer);
      if (!fen) return;
      if (st && st.over) { this._terminal(st); return; }
      const token = this.token;
      this.timer = setTimeout(() => this._analyze(fen, token), 260);
    }

    _terminal(st) {
      this.ui.bar(st.code === 'checkmate' ? (st.winner === 'w' ? 1 : 0) : 0.5);
      this.ui.moves(null, st);
      this.ui.meta('对局结束');
    }

    async _analyze(fen, token) {
      if (token !== this.token) return;
      if (!this.engine) {
        this.engine = new Engine();
        this.ui.meta('分析引擎启动中…');
      }
      try {
        if (!this.engine.ready) await this.engine.init();
      } catch (err) {
        this.ui.meta('分析引擎不可用');
        return;
      }
      if (token !== this.token) return;
      if (this.inflight) {
        this.engine.cancel();
        try { await this.inflight; } catch (e) { /* 旧搜索被取消，忽略 */ }
        if (token !== this.token) return;
      }
      this._records = {};
      this._depth = 0;
      const turn = fen.split(' ')[1];
      this.inflight = this.engine.analyze(fen, { multiPV: 3, movetime: 500 }, (line) => {
        if (token !== this.token) return;
        this._consume(fen, turn, line);
      });
      try { await this.inflight; } catch (e) { /* 超时/取消 */ }
      finally { this.inflight = null; }
    }

    _consume(fen, turn, line) {
      const info = parseInfoLine(line);
      if (!info) return;
      const uci = info.pv[0];
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return;
      const san = this._san(fen, uci);
      if (!san) return;

      // WDL / cp / mate 均为行棋方视角 → 统一换算成白方视角
      let w, d, l, cpWhite = null;
      if (info.wdl) {
        [w, d, l] = turn === 'w' ? info.wdl : [info.wdl[2], info.wdl[1], info.wdl[0]];
      } else if (info.cp !== undefined) {
        cpWhite = turn === 'w' ? info.cp : -info.cp;
      } else if (info.mate !== undefined) {
        const whiteWins = (info.mate > 0) === (turn === 'w');
        w = whiteWins ? 1000 : 0; d = 0; l = whiteWins ? 0 : 1000;
      } else {
        return;
      }

      this._records[info.multipv || 1] = { multipv: info.multipv || 1, san, w, d, l, cpWhite };
      if (info.depth) this._depth = info.depth;
      this._render(fen);
    }

    _san(fen, uci) {
      if (!this.scratch.load(fen)) return null;
      const m = this.scratch.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4) : undefined,
      });
      return m ? m.san : null;
    }

    _render(fen) {
      const turn = fen.split(' ')[1];
      const list = Object.keys(this._records).map(Number).sort((a, b) => a - b).map((k) => this._records[k]);
      if (!list.length) return;
      this.ui.moves(list, null);
      this.ui.meta(`${turn === 'w' ? '白先' : '黑先'} · 深度 ${this._depth || '—'}`);
      const top = this._records[1];
      if (top) {
        const share = top.w !== undefined
          ? (top.w + top.d / 2) / 1000
          : top.cpWhite !== null
            ? 1 / (1 + Math.exp(-0.00368208 * top.cpWhite))
            : 0.5;
        this.ui.bar(share);
      }
    }
  }

  /* ---------- BoardView：棋盘渲染与交互 ---------- */
  class BoardView {
    /**
     * hooks:
     *   interactive()        当前是否允许棋盘输入（对局中且无弹窗）
     *   pieceAt(sq)          取某格棋子 {type,color} | null
     *   turnColor()          当前行棋方
     *   targetsFor(sq)       某格棋子的合法走法列表
     *   requestMove(from,to) 发起走子：'ok' | 'promotion' | 'illegal'
     *   onIllegal()          非法走法提示（toast）
     */
    constructor(root, hooks) {
      this.root = root;
      this.hooks = hooks;
      this.orientation = 'w';          // 'w' = 白方在下
      this.squares = new Map();        // square -> 格子元素
      this.pieces = new Map();         // square -> 棋子元素
      this.selected = null;
      this.targets = [];
      this.lastMove = null;
      this.checkSquare = null;
      this.drag = null;
      this.editMode = false;         // 局面编辑模式（自由摆子）

      this.root.innerHTML = '';
      this.squaresEl = document.createElement('div');
      this.squaresEl.className = 'squares';
      this.piecesEl = document.createElement('div');
      this.piecesEl.className = 'pieces';
      this.root.appendChild(this.squaresEl);
      this.root.appendChild(this.piecesEl);

      this.buildSquares();
      this._bind();
    }

    /* ----- 坐标换算（显示坐标 vs 棋盘坐标） ----- */
    frToDisplay(f, r) {
      return this.orientation === 'w' ? { col: f, row: 7 - r } : { col: 7 - f, row: r };
    }
    displayToFr(col, row) {
      return this.orientation === 'w' ? { f: col, r: 7 - row } : { f: 7 - col, r: row };
    }
    sqToDisplay(sq) { return this.frToDisplay(fileIdx(sq), rankIdx(sq)); }

    /* ----- 格子 ----- */
    buildSquares() {
      this.squaresEl.innerHTML = '';
      this.squares.clear();
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const { f, r } = this.displayToFr(col, row);
          const sq = sqAt(f, r);
          const el = document.createElement('div');
          el.className = 'square ' + ((f + r) % 2 === 0 ? 'dark' : 'light');
          el.dataset.square = sq;
          el.setAttribute('role', 'gridcell');
          if (col === 0) {
            const c = document.createElement('span');
            c.className = 'coord rank';
            c.textContent = String(r + 1);
            el.appendChild(c);
          }
          if (row === 7) {
            const c = document.createElement('span');
            c.className = 'coord file';
            c.textContent = FILES[f];
            el.appendChild(c);
          }
          this.squaresEl.appendChild(el);
          this.squares.set(sq, el);
        }
      }
      this.updateAriaAll();
    }

    /* ----- 棋子元素 ----- */
    createPieceEl(code) {
      const el = document.createElement('div');
      el.className = 'piece ' + code[0];
      el.dataset.piece = code;
      const g = document.createElement('div');
      g.className = 'glyph';
      g.innerHTML = PIECE_SVG[code];
      el.appendChild(g);
      return el;
    }

    placePieceEl(el, sq) {
      const { col, row } = this.sqToDisplay(sq);
      el.dataset.square = sq;
      el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
    }

    setPiece(sq, code) {
      const el = this.createPieceEl(code);
      this.pieces.set(sq, el);
      this.piecesEl.appendChild(el);
      this.placePieceEl(el, sq);
      this.updateAria(sq);
      return el;
    }

    removePiece(sq) {
      const el = this.pieces.get(sq);
      if (!el) return;
      this.pieces.delete(sq);
      el.classList.add('captured');
      el.style.pointerEvents = 'none';
      setTimeout(() => el.remove(), 240);
      this.updateAria(sq);
    }

    movePieceEl(from, to) {
      const el = this.pieces.get(from);
      if (!el) return;
      this.pieces.delete(from);
      this.pieces.set(to, el);
      this.placePieceEl(el, to);
      this.updateAria(from);
      this.updateAria(to);
    }

    setPieceCode(sq, code) {
      const el = this.pieces.get(sq);
      if (!el) return;
      el.dataset.piece = code;
      el.classList.toggle('w', code[0] === 'w');
      el.classList.toggle('b', code[0] === 'b');
      el.firstChild.innerHTML = PIECE_SVG[code];
      this.updateAria(sq);
    }

    findKing(color) {
      const code = color + 'K';
      for (const [sq, el] of this.pieces) {
        if (el.dataset.piece === code) return sq;
      }
      return null;
    }

    updateAria(sq) {
      const el = this.squares.get(sq);
      if (!el) return;
      const p = this.hooks.pieceAt(sq);
      el.setAttribute('aria-label', p ? `${sq} ${colorName(p.color)}${PIECE_ZH[p.type]}` : sq);
    }
    updateAriaAll() { for (const sq of this.squares.keys()) this.updateAria(sq); }

    /* ----- 整盘重绘（悔棋 / 重开 / 载入 FEN） ----- */
    renderAll(fen) {
      this.drag = null;
      this.piecesEl.classList.add('no-anim');
      this.piecesEl.innerHTML = '';
      this.pieces.clear();
      const rows = fen.split(' ')[0].split('/');
      for (let ri = 0; ri < 8; ri++) {          // rows[0] = 第 8 横排
        const r = 7 - ri;
        let f = 0;
        for (const ch of rows[ri]) {
          if (ch >= '1' && ch <= '8') { f += Number(ch); continue; }
          const color = ch === ch.toUpperCase() ? 'w' : 'b';
          this.setPiece(sqAt(f, r), color + ch.toUpperCase());
          f++;
        }
      }
      void this.piecesEl.offsetWidth;           // 强制回流，避免初始渲染动画
      this.piecesEl.classList.remove('no-anim');
      this.updateAriaAll();
    }

    /* ----- 执行一步后的定点更新（带动画） ----- */
    applyMove(m) {
      // 吃子（吃过路兵时被吃兵不在目标格）
      if (m.flags.includes('e')) this.removePiece(m.to[0] + m.from[1]);
      else if (m.captured) this.removePiece(m.to);

      this.movePieceEl(m.from, m.to);

      if (m.promotion) this.setPieceCode(m.to, m.color + m.promotion.toUpperCase());

      // 王车易位：同排车同步移动
      if (m.flags.includes('k') || m.flags.includes('q')) {
        const rank = m.color === 'w' ? '1' : '8';
        const rookFrom = (m.flags.includes('k') ? 'h' : 'a') + rank;
        const rookTo = (m.flags.includes('k') ? 'f' : 'd') + rank;
        this.movePieceEl(rookFrom, rookTo);
      }
    }

    /* ----- 高亮标记 ----- */
    updateMarks() {
      for (const el of this.squares.values()) {
        el.classList.remove('selected', 'last', 'check', 'legal-dot', 'legal-capture', 'drag-over', 'drag-bad');
      }
      if (this.lastMove) {
        this.squares.get(this.lastMove.from)?.classList.add('last');
        this.squares.get(this.lastMove.to)?.classList.add('last');
      }
      if (this.checkSquare) this.squares.get(this.checkSquare)?.classList.add('check');
      if (this.selected) {
        this.squares.get(this.selected)?.classList.add('selected');
        for (const mv of this.targets) {
          const isCapture = mv.flags.includes('c') || mv.flags.includes('e');
          this.squares.get(mv.to)?.classList.add(isCapture ? 'legal-capture' : 'legal-dot');
        }
      }
    }

    setLastMove(mv) { this.lastMove = mv; this.updateMarks(); }
    setCheck(sq) { this.checkSquare = sq; this.updateMarks(); }
    select(sq) {
      this.selected = sq;
      this.targets = this.hooks.targetsFor(sq);
      this.updateMarks();
    }
    clearSelection() { this.selected = null; this.targets = []; this.updateMarks(); }

    flashInvalid(sq) {
      const el = this.squares.get(sq);
      if (!el) return;
      el.classList.remove('invalid');
      void el.offsetWidth;
      el.classList.add('invalid');
      setTimeout(() => el.classList.remove('invalid'), 620);
    }

    shake(el) {
      el.classList.remove('shake');
      void el.offsetWidth;
      el.classList.add('shake');
      setTimeout(() => el.classList.remove('shake'), 380);
    }

    /* ----- 翻转 ----- */
    setOrientation(o, { animate = true } = {}) {
      if (this.orientation === o) return;
      this.orientation = o;
      this.buildSquares();
      if (animate) {
        for (const [sq, el] of this.pieces) this.placePieceEl(el, sq);   // 平滑换位
      }
      this.updateMarks();
    }

    /* ----- 局面编辑模式 ----- */
    setEditMode(on) {
      this.editMode = !!on;
      this.clearSelection();
    }

    /* ----- 指针交互：拖拽 + 点击 ----- */
    _bind() {
      this.root.addEventListener('pointerdown', (e) => this._down(e));
      this.root.addEventListener('pointermove', (e) => this._move(e));
      this.root.addEventListener('pointerup', (e) => this._up(e));
      this.root.addEventListener('pointercancel', (e) => this._cancel(e));
      this.root.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // 编辑模式：右键删除棋子
        if (this.editMode) {
          const sq = this.squareFromPoint(e.clientX, e.clientY);
          if (sq && this.hooks.pieceAt(sq)) this.hooks.onEditErase(sq);
        }
      });
    }

    /** 屏幕坐标 → 格子（超出棋盘返回 null） */
    squareFromPoint(x, y) {
      const rect = this.root.getBoundingClientRect();
      const px = x - rect.left, py = y - rect.top;
      if (px < 0 || py < 0 || px >= rect.width || py >= rect.height) return null;
      const col = Math.min(7, Math.floor(px / (rect.width / 8)));
      const row = Math.min(7, Math.floor(py / (rect.height / 8)));
      const { f, r } = this.displayToFr(col, row);
      return sqAt(f, r);
    }

    _down(e) {
      if (this.drag || e.button !== 0) return;
      if (this.editMode) return this._editDown(e);
      if (!this.hooks.interactive()) return;
      const sq = this.squareFromPoint(e.clientX, e.clientY);
      if (!sq) return;

      const piece = this.hooks.pieceAt(sq);
      if (piece && piece.color === this.hooks.turnColor()) {
        // 按在己方棋子上：可能开始拖拽 / 切换选中
        const el = this.pieces.get(sq);
        const wasSelected = this.selected === sq;
        this.select(sq);
        this.drag = this._startDrag(el, sq, e, { wasSelected });
        e.preventDefault();
      } else if (this.selected) {
        // 点击-点击模式：目标是空格或对方棋子
        const res = this.hooks.requestMove(this.selected, sq);
        if (res === 'illegal') this.flashInvalid(sq);
        // 'ok' / 'promotion' 由 App 侧完成清理
      }
    }

    /* ----- 编辑模式按下：调色板放置 / 拖动棋子 ----- */
    _editDown(e) {
      const sq = this.squareFromPoint(e.clientX, e.clientY);
      if (!sq) return;
      const pick = this.hooks.editPick();            // 'wQ' 等棋子代码 | 'erase' | null
      if (pick && pick !== 'erase') { this.hooks.onEditPlace(pick, sq); return; }
      if (pick === 'erase') { this.hooks.onEditErase(sq); return; }
      const piece = this.hooks.pieceAt(sq);
      if (piece) {
        const el = this.pieces.get(sq);
        const wasSelected = this.selected === sq;
        this.select(sq);                              // targets 在编辑模式下为空 → 仅高亮
        this.drag = this._startDrag(el, sq, e, { wasSelected, edit: true });
        e.preventDefault();
      } else if (this.selected) {
        // 点击-点击移动：把选中的棋子移到此格
        const from = this.selected;
        this.clearSelection();
        this.hooks.onEditMove(from, sq);
      }
    }

    /** 开始一次拖拽：记录抓取点相对棋子中心的偏移，拖动时棋子不发生瞬移 */
    _startDrag(el, sq, e, { wasSelected = false, edit = false } = {}) {
      const pr = el.getBoundingClientRect();
      const d = {
        from: sq, el,
        x0: e.clientX, y0: e.clientY,
        moved: false,
        wasSelected,
        id: e.pointerId, hoverSq: null,
        edit,
        grabDX: e.clientX - (pr.left + pr.width / 2),
        grabDY: e.clientY - (pr.top + pr.height / 2),
      };
      try { el.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      el.classList.add('grabbing');
      return d;
    }

    _move(e) {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;  // 拖拽阈值
        d.moved = true;
        d.el.classList.add('dragging');
      }
      const rect = this.root.getBoundingClientRect();
      const cell = rect.width / 8;
      // 保持抓取点贴住指针（含初始偏移），棋子从原位平滑跟手、无瞬移
      const px = e.clientX - rect.left - cell / 2 - d.grabDX;
      const py = e.clientY - rect.top - cell / 2 - d.grabDY;
      d.el.style.transform = `translate(${px}px, ${py}px)`;

      // 悬停格反馈：合法 = 加亮，非法 = 红色禁止（编辑模式下任意格均可放）
      if (d.hoverSq) this.squares.get(d.hoverSq)?.classList.remove('drag-over', 'drag-bad');
      const sq = this.squareFromPoint(e.clientX, e.clientY);
      d.hoverSq = sq;
      if (sq) {
        const legal = d.edit || this.targets.some((mv) => mv.to === sq);
        this.squares.get(sq)?.classList.add(legal ? 'drag-over' : 'drag-bad');
      }
      e.preventDefault();
    }

    _up(e) {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.drag = null;
      d.el.classList.remove('grabbing');
      if (!d.moved) {
        // 只是点击己方棋子：再次点击取消选中
        if (d.wasSelected) this.clearSelection();
        return;
      }
      if (d.edit) this._finishEditDrag(d, this.squareFromPoint(e.clientX, e.clientY));
      else this._finishDrag(d, this.squareFromPoint(e.clientX, e.clientY));
    }

    _cancel(e) {
      const d = this.drag;
      if (!d || (e.pointerId !== undefined && e.pointerId !== d.id)) return;
      this.drag = null;
      d.el.classList.remove('grabbing');
      if (d.edit) this._finishEditDrag(d, null);      // 取消 = 拖出棋盘 = 删除
      else this._finishDrag(d, null);
    }

    _finishDrag(d, targetSq) {
      if (d.hoverSq) this.squares.get(d.hoverSq)?.classList.remove('drag-over', 'drag-bad');
      d.el.classList.remove('dragging');

      let res = null;
      if (targetSq && targetSq !== d.from) res = this.hooks.requestMove(d.from, targetSq);
      if (res === 'ok') return;                 // 成功：applyMove 已接管该棋子

      // 非法 / 升变待定 / 落回原格 / 棋盘外：棋子归位
      d.el.style.transform = '';
      this.placePieceEl(d.el, d.from);
      if (res === 'illegal') {
        this.flashInvalid(targetSq);
        this.shake(d.el);
        this.hooks.onIllegal();
      }
    }

    /* ----- 编辑模式拖拽结束：移动 / 拖出棋盘删除 ----- */
    _finishEditDrag(d, targetSq) {
      if (d.hoverSq) this.squares.get(d.hoverSq)?.classList.remove('drag-over', 'drag-bad');
      d.el.classList.remove('dragging');
      this.clearSelection();
      if (!targetSq) { this.hooks.onEditErase(d.from); return; }
      if (targetSq === d.from) {
        d.el.style.transform = '';
        this.placePieceEl(d.el, d.from);
        return;
      }
      this.hooks.onEditMove(d.from, targetSq);
    }
  }

  /* ---------- MoveList：走子记录（点击任意一步回看该局面） ---------- */
  class MoveList {
    constructor(el, chipEl, onPly) {
      this.el = el;
      this.chipEl = chipEl;
      this.onPly = onPly;
      this.el.addEventListener('click', (e) => {
        const t = e.target.closest('.ply[data-ply]');
        if (t && this.onPly) this.onPly(Number(t.dataset.ply));
      });
    }

    /**
     * @param history     完整走子序列（verbose）
     * @param currentPly  当前查看的位置（已走步数；小于总步数 = 回看中）
     */
    render(history, currentPly) {
      const n = history.length;
      const cur = Math.max(0, Math.min(currentPly ?? n, n));
      this.chipEl.textContent = cur < n ? `回看 ${cur}/${n}` : `${n} 步`;
      if (!n) {
        this.el.innerHTML = '<div class="moves-empty">尚无走子 · 白方先行</div>';
        return;
      }
      const rows = [];
      for (let i = 0; i < n; i += 2) {
        const w = history[i], b = history[i + 1];
        rows.push(
          `<div class="mrow"><span class="mno">${i / 2 + 1}.</span>` +
          this._ply(w, i + 1, cur) +
          (b ? this._ply(b, i + 2, cur) : '<span class="ply"></span>') +
          `</div>`
        );
      }
      this.el.innerHTML = rows.join('');
      // 只滚动列表容器自身，绝不带动页面滚动
      //（scrollIntoView 会连文档一起滚：移动端走子记录位于折叠线下方，
      //  每走一步都会把整页拽下去，表现为“走棋后界面往上跳一下”）
      this._scrollSelf();
    }

    _scrollSelf() {
      const curEl = this.el.querySelector('.ply.current');
      if (!curEl) { this.el.scrollTop = this.el.scrollHeight; return; }
      const cr = this.el.getBoundingClientRect();
      const er = curEl.getBoundingClientRect();
      if (er.top < cr.top) this.el.scrollTop += er.top - cr.top;
      else if (er.bottom > cr.bottom) this.el.scrollTop += er.bottom - cr.bottom;
    }

    _ply(m, idx, cur) {
      const cls = `ply${idx === cur ? ' current' : ''}${idx > cur ? ' future' : ''}`;
      return `<span class="${cls}" data-ply="${idx}" title="点击回看此局面">${m.san}</span>`;
    }
  }

  /* ---------- StatusPanel：状态卡 ---------- */
  class StatusPanel {
    constructor(els) { Object.assign(this, els); }

    /** info: { turn, st, plies, last } —— 均对应“当前查看的位置” */
    update({ turn, st, plies, last }) {
      if (st.over) {
        this.turnEl.innerHTML = st.code === 'checkmate'
          ? `${PIECE_SVG[st.winner + 'K']} <span>${colorName(st.winner)}胜</span>`
          : '<span>对局结束</span>';
      } else {
        this.turnEl.innerHTML = `${PIECE_SVG[turn + 'K']} <span>${colorName(turn)}</span>`;
      }
      this.stateEl.textContent = st.text;
      this.stateEl.className = 'stat-value st-' + (st.over ? 'over' : st.code);
      this.pliesEl.textContent = plies;
      this.lastEl.textContent = last || '—';
    }
  }

  /* ---------- PlayerCards：玩家卡片 ---------- */
  class PlayerCards {
    constructor(topEl, bottomEl) { this.top = topEl; this.bottom = bottomEl; }

    /**
     * @param ctx { mode, humanColor, levelName, thinking, booting } 人机模式上下文
     */
    update(game, st, history, orientation, ctx = {}) {
      const captured = { w: [], b: [] };
      const mat = { w: 0, b: 0 };
      for (const m of history) {
        if (m.captured) { captured[m.color].push(m.captured); mat[m.color] += PIECE_VALUE[m.captured]; }
      }
      const diff = mat.w - mat.b;
      const topColor = other(orientation);

      for (const [el, color] of [[this.top, topColor], [this.bottom, orientation]]) {
        const isAI = ctx.mode === 'ai' && color !== ctx.humanColor;
        const active = !st.over && game.turn() === color;
        const won = st.over && st.code === 'checkmate' && st.winner === color;
        const adv = color === 'w' ? diff : -diff;
        const minis = captured[color]
          .sort((a, b) => PIECE_VALUE[b] - PIECE_VALUE[a])
          .map((t) => `<span class="mini">${PIECE_SVG[other(color) + t.toUpperCase()]}</span>`)
          .join('');

        let badge, badgeOn = active;
        if (isAI && ctx.booting) { badge = '引擎启动中…'; badgeOn = true; }
        else if (isAI && ctx.thinking) { badge = '思考中…'; badgeOn = true; }
        else if (st.over) badge = st.code === 'checkmate' ? (won ? '胜' : '负') : '和';
        else badge = active ? '行棋中' : '等待';

        const name = isAI
          ? `AI · ${ctx.levelName || 'Stockfish'}`
          : (ctx.playerNames && ctx.playerNames[color]) || colorName(color);
        el.innerHTML =
          `<div class="avatar">${PIECE_SVG[color + 'K']}</div>` +
          `<div class="pinfo"><div class="pname">${name}${won ? ' · 获胜' : ''}</div>` +
          `<div class="captured">${minis}</div></div>` +
          (adv > 0 ? `<div class="pmaterial">+${adv}</div>` : '') +
          `<div class="pbadge${badgeOn ? ' on' : ''}">${badge}</div>`;
        el.classList.toggle('active', badgeOn || won);
      }
    }
  }

  /* ---------- 弹窗：升变 / 新游戏 / 结束横幅 ---------- */
  class PromotionDialog {
    constructor(app) {
      this.app = app;
      this.el = $('#promoModal');
      this.grid = $('#promoGrid');
      this.pending = null;
      $('#promoCancel').addEventListener('click', () => this.app.cancelPromotion());
      this.el.addEventListener('click', (e) => { if (e.target === this.el) this.app.cancelPromotion(); });
    }

    open({ from, to, color }) {
      this.pending = { from, to };
      this.grid.innerHTML = '';
      for (const t of PROMO_ORDER) {
        const btn = document.createElement('button');
        btn.className = 'promo-btn';
        btn.innerHTML = `<span class="promo-glyph">${PIECE_SVG[color + t.toUpperCase()]}</span><span>${PIECE_ZH[t]}</span>`;
        btn.addEventListener('click', () => {
          const p = this.pending;
          this.app.closePromotion();
          if (p) this.app.executeMove(p.from, p.to, t);
        });
        this.grid.appendChild(btn);
      }
      this.el.hidden = false;
    }
  }

  class NewGameDialog {
    constructor(app) {
      this.app = app;
      this.el = $('#newModal');
      this.state = { mode: 'ai-w', level: 1, orientation: 'w' };   // 默认：执白对 AI · 休闲

      // 难度按钮由 AI_LEVELS 生成（单一数据源）
      const levelSeg = $('[data-seg="level"]');
      for (let i = 0; i < AI_LEVELS.length; i++) {
        const btn = document.createElement('button');
        btn.className = 'seg-btn';
        btn.dataset.value = String(i);
        btn.textContent = AI_LEVELS[i].name;
        btn.addEventListener('click', () => { this.state.level = i; this._render(); });
        levelSeg.appendChild(btn);
      }
      // 模式 / 方向按钮
      for (const btn of this.el.querySelectorAll('.seg-btn')) {
        if (btn.closest('[data-seg="mode"]')) {
          btn.addEventListener('click', () => { this.state.mode = btn.dataset.value; this._render(); });
        } else if (btn.closest('[data-seg="orientation"]')) {
          btn.addEventListener('click', () => { this.state.orientation = btn.dataset.value; this._render(); });
        }
      }
      $('#newStart').addEventListener('click', () => this.start());
      $('#newCancel').addEventListener('click', () => this.close());
      this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });

      // 图标
      for (const icon of this.el.querySelectorAll('[data-icon]')) {
        const key = icon.dataset.icon;
        icon.innerHTML = key === 'pair' ? PIECE_SVG.wK + PIECE_SVG.bK : PIECE_SVG[key];
      }
    }

    open() { this.el.hidden = false; this._render(); }
    close() { this.el.hidden = true; }

    _render() {
      const { mode, level, orientation } = this.state;
      for (const btn of this.el.querySelectorAll('[data-seg="mode"] .seg-btn')) {
        btn.classList.toggle('on', btn.dataset.value === mode);
      }
      for (const btn of this.el.querySelectorAll('[data-seg="level"] .seg-btn')) {
        btn.classList.toggle('on', Number(btn.dataset.value) === level);
      }
      for (const btn of this.el.querySelectorAll('[data-seg="orientation"] .seg-btn')) {
        btn.classList.toggle('on', btn.dataset.value === orientation);
      }
      const isAI = mode !== 'pvp';
      $('[data-seg="level"]').previousElementSibling.style.display = isAI ? '' : 'none';
      $('[data-seg="level"]').style.display = isAI ? '' : 'none';
      $('[data-seg="orientation"]').previousElementSibling.style.display = isAI ? 'none' : '';
      $('[data-seg="orientation"]').style.display = isAI ? 'none' : '';
    }

    start() {
      const s = this.state;
      this.close();
      if (s.mode === 'pvp') {
        const o = s.orientation === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : s.orientation;
        this.app.newGame({ mode: 'pvp', orientation: o });
      } else {
        const humanColor = s.mode === 'ai-w' ? 'w' : 'b';
        this.app.newGame({ mode: 'ai', humanColor, aiLevel: s.level, orientation: humanColor });
      }
    }
  }

  class Banner {
    constructor(app) {
      this.app = app;
      this.el = $('#bannerLayer');
      $('#bannerTitle').textContent = '';
      $('#bannerSub').textContent = '';
      $('#bannerNew').addEventListener('click', () => { this.hide(); app.newGame(); });
      $('#bannerClose').addEventListener('click', () => this.hide());
    }

    show(st) {
      $('#bannerTitle').textContent = st.bannerTitle;
      $('#bannerSub').textContent = st.bannerSub;
      this.el.hidden = false;
    }
    hide() { this.el.hidden = true; }
  }

  /* ---------- 通用 UI 工具 ---------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      toast(ok ? okMsg : '复制失败，请手动选择文本复制');
    }
  }

  function downloadText(name, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已开始下载 ${name}`);
  }

  /* ---------- App：组装与流程控制 ---------- */
  class App {
    constructor() {
      this.game = new Game();
      this.st = this.game.status();
      this.promotionPending = false;

      // 回看 / 分叉状态
      this.viewPly = null;         // null = 实时局面；数字 = 回看到第几步之后
      this.deviatePly = null;      // 回看中发起的走子：待截断的步数
      this.importedPgn = null;     // 导入的原始 PGN（导出时可原样取回）
      this.playerNames = { w: '', b: '' };
      this.pos = this.game.chess;        // 当前查看位置（回看时为历史局面）
      this.viewCtx = { st: this.st, turn: 'w', browsing: false };
      this._pgnView = 'new';             // 导出弹窗当前显示：'new' | 'orig'

      // 局面编辑器状态
      this.editing = false;
      this.editor = { map: {}, turn: 'w', pick: null };

      // 沉浸模式
      this.immersive = false;

      // 人机对战状态
      this.mode = 'pvp';            // 'pvp' | 'ai'
      this.humanColor = 'w';
      this.aiLevel = 1;
      this.settings = { mode: 'ai', humanColor: 'w', aiLevel: 1, orientation: 'w' };   // 默认：执白对 AI（休闲）
      this.engine = null;           // Engine 懒加载
      this.aiThinking = false;
      this.aiBooting = false;
      this.aiScheduled = false;
      this.aiBroken = false;
      this.epoch = 0;               // 代际号：重开/悔棋后丢弃在途的 AI 结果

      this.view = new BoardView($('#board'), {
        interactive: () =>
          !this.viewCtx.st.over &&
          !this.promotionPending &&
          !this.aiThinking &&
          !this.aiBooting &&
          (this.mode !== 'ai' || this.viewCtx.turn === this.humanColor),
        pieceAt: (sq) => (this.editing ? this.editor.map[sq] || null : this.pos ? this.pos.get(sq) || null : null),
        turnColor: () => (this.editing ? this.editor.turn : this.pos ? this.pos.turn() : 'w'),
        targetsFor: (sq) =>
          this.editing || !this.pos || !isSquare(sq) ? [] : this.pos.moves({ square: sq, verbose: true }),
        requestMove: (from, to) => this.requestMove(from, to),
        onIllegal: () => toast('不合法的走法'),
        editPick: () => (this.editing ? this.editor.pick : null),
        onEditPlace: (code, sq) => this.editPlace(code, sq),
        onEditErase: (sq) => this.editErase(sq),
        onEditMove: (from, to) => this.editMove(from, to),
      });

      this.movelist = new MoveList($('#moves'), $('#movesChip'), (ply) => this.gotoPly(ply));
      this.panel = new StatusPanel({
        turnEl: $('#statTurn'), stateEl: $('#statState'),
        pliesEl: $('#statPlies'), lastEl: $('#statLast'),
      });
      this.cards = new PlayerCards($('#playerTop'), $('#playerBottom'));
      this.promotion = new PromotionDialog(this);
      this.newDialog = new NewGameDialog(this);
      this.banner = new Banner(this);
      this.analysis = new Analysis({
        bar: (share) => {
          const h = Math.max(0, Math.min(1, share)) * 100;
          $('#evalFill').style.height = h.toFixed(1) + '%';
        },
        meta: (text) => { $('#evalMeta').textContent = text; },
        moves: (list, st) => this.renderEvalMoves(list, st),
      });

      $('#logo').innerHTML = PIECE_SVG.bN;
      this._bindControls();

      this.newGame({ mode: 'ai', humanColor: 'w', orientation: 'w' });   // 默认开一局执白对 AI

      // 控制台 API（也为自动化测试 / 后续 AI 扩展预留）
      window.chessApp = {
        api: {
          move: (from, to, promotion) => this.apiMove(from, to, promotion),
          undo: () => this.undo(),
          reset: () => this.newGame(),
          flip: () => this.flip(),
          fen: () => this.game.fen(),
          pgn: () => this.buildPgn(),
          status: () => this.game.status(),
          history: () => this.game.history().map((m) => m.san),
          loadFen: (fen) => this.loadFen(fen),
          orientation: () => this.view.orientation,
          gotoPly: (ply) => this.gotoPly(ply),
          viewPly: () => this.viewPly,
          importPgn: (text) => this.loadPgnGame(text),
          importedPgn: () => this.importedPgn,
          editor: () => ({ editing: this.editing, fen: this.editing ? this.editorFen() : null }),
        },
        ai: {
          info: () => ({
            mode: this.mode,
            humanColor: this.humanColor,
            level: this.aiLevel,
            levelName: AI_LEVELS[this.aiLevel].name,
            thinking: this.aiThinking,
            booted: !!(this.engine && this.engine.ready),
          }),
          /** 直接询问引擎（调试/测试用），不影响棋盘 */
          think: (fen, level = this.aiLevel) => {
            if (!this.engine) this.engine = new Engine();
            return this.engine.think(fen, AI_LEVELS[level]);
          },
        },
      };
    }

    /* ----- 走子流程（回看中走出新着 = 从该局面分叉，截断后续走法） ----- */
    _legalAt(pos, from, to) {
      if (!pos || !isSquare(from) || !isSquare(to)) return [];
      return pos.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    }

    requestMove(from, to) {
      const pos = this.pos;
      if (!pos || this.viewCtx.st.over) return 'illegal';
      const cand = this._legalAt(pos, from, to);
      if (!cand.length) return 'illegal';
      this.view.clearSelection();
      if (this.viewPly !== null) this.deviatePly = this.viewPly;   // 回看分叉，待执行时截断
      if (cand.some((m) => m.flags.includes('p'))) {
        this.promotionPending = true;
        this.promotion.open({ from, to, color: pos.turn() });
        return 'promotion';
      }
      this.executeMove(from, to);
      return 'ok';
    }

    executeMove(from, to, promotion) {
      if (this.deviatePly !== null) {
        // 回看分叉生效：截断原走法序列，新走法成为主线
        this.game.truncateTo(this.deviatePly);
        this.deviatePly = null;
        this.viewPly = null;
        this.epoch++;
        if (this.aiThinking) { this.engine?.cancel(); this.aiThinking = false; }
      }
      const m = this.game.move({ from, to, promotion });
      if (!m) { this.view.flashInvalid(to); toast('不合法的走法'); return null; }
      this.view.applyMove(m);
      this.refresh(m);
      return m;
    }

    apiMove(from, to, promotion) {
      const pos = this.pos;
      if (!pos || this.viewCtx.st.over) return null;
      const cand = this._legalAt(pos, from, to);
      if (!cand.length) return null;
      if (this.viewPly !== null) this.deviatePly = this.viewPly;
      const promo = promotion || (cand.some((m) => m.flags.includes('p')) ? 'q' : undefined);
      const m = this.executeMove(from, to, promo);
      return m ? m.san : null;
    }

    closePromotion() {
      this.promotion.pending = null;
      this.promotion.el.hidden = true;
      this.promotionPending = false;
    }
    cancelPromotion() { this.closePromotion(); this.deviatePly = null; }

    /* ----- 统一刷新（所有 UI 状态由引擎状态推导；回看时展示历史局面） ----- */
    refresh(afterMove) {
      if (this.editing) {                                   // 编辑模式：渲染编辑局面即可
        this.view.setLastMove(null);
        this.view.setCheck(null);
        this.view.renderAll(this.editorFen());
        this.panel.update({
          turn: this.editor.turn,
          st: { over: false, code: 'normal', text: '编辑中' },
          plies: '—', last: '—',
        });
        $('#statMode').textContent = '编辑模式 · 自由摆放棋子';
        $('#btnLatest').hidden = true;
        $('#btnUndo').disabled = true;
        return;
      }
      this.st = this.game.status();
      const history = this.game.history();
      const n = history.length;

      // 回看状态归一化（截断/悔棋后步数可能变少）
      if (this.viewPly !== null && this.viewPly >= n) this.viewPly = null;
      const browsing = this.viewPly !== null;

      // 计算当前查看位置（实时或历史）
      let pos, vSt, vTurn, vHist, lastMv;
      if (browsing) {
        pos = this.game.boardAt(this.viewPly);
        vHist = history.slice(0, this.viewPly);
        vSt = computeStatus(pos);
        vTurn = pos.turn();
        lastMv = vHist[vHist.length - 1] || null;
        this.view.renderAll(pos.fen());
        this.view.clearSelection();
      } else {
        pos = this.game.chess;
        vHist = history;
        vSt = this.st;
        vTurn = pos.turn();
        lastMv = history[n - 1] || null;
      }
      this.pos = pos;
      this.viewCtx = { st: vSt, turn: vTurn, browsing };

      this.view.setLastMove(lastMv ? { from: lastMv.from, to: lastMv.to } : null);
      const checkSq = (vSt.code === 'check' || vSt.code === 'checkmate')
        ? this.view.findKing(vTurn)
        : null;
      this.view.setCheck(checkSq);

      this.movelist.render(history, browsing ? this.viewPly : n);
      this.panel.update({
        turn: vTurn, st: vSt,
        plies: browsing ? `${this.viewPly}/${n}` : String(n),
        last: lastMv ? lastMv.san : '—',
      });
      this.cards.update({ turn: () => vTurn }, vSt, vHist, this.view.orientation, {
        mode: this.mode,
        humanColor: this.humanColor,
        levelName: AI_LEVELS[this.aiLevel].name,
        thinking: this.aiThinking,
        booting: this.aiBooting,
        playerNames: this.importedPgn ? this.playerNames : null,
      });

      $('#btnLatest').hidden = !browsing;
      $('#statMode').textContent = this.importedPgn
        ? '导入棋谱 · 点击走子可回看'
        : this.mode === 'ai'
          ? `人机 · 你执${this.humanColor === 'w' ? '白' : '黑'} · ${AI_LEVELS[this.aiLevel].name}`
          : '双人对战';
      $('#fenText').textContent = pos.fen();
      $('#btnUndo').disabled = n === 0;

      if (browsing) this.banner.hide();
      else if (!this.st.over) this.banner.hide();
      else if (afterMove) setTimeout(() => {
        if (this.st.over && this.viewPly === null) this.banner.show(this.st);
      }, 420);
      else this.banner.show(this.st);

      this.analysis.setPosition(pos.fen(), vSt);
      this.scheduleAI();
    }

    /* ----- 走子记录回看 ----- */
    gotoPly(ply) {
      if (this.editing) return;
      if (this.promotionPending) this.cancelPromotion();
      const n = this.game.history().length;
      const k = Math.max(0, Math.min(ply, n));
      this.viewPly = k === n ? null : k;
      this.view.clearSelection();
      this.refresh();
    }

    /* ----- 走法胜率面板渲染 ----- */
    renderEvalMoves(list, st) {
      const el = $('#evalMoves');
      if (st) {
        el.innerHTML = `<div class="moves-empty">${st.code === 'checkmate' ? `${colorName(st.winner)}获胜 · 将死` : '和棋'}</div>`;
        return;
      }
      if (!list || !list.length) { el.innerHTML = '<div class="moves-empty">分析中…</div>'; return; }
      el.innerHTML = list.map((r) => {
        const best = r.multipv === 1 ? ' best' : '';
        if (r.w !== undefined) {
          const pw = Math.round(r.w / 10), pd = Math.round(r.d / 10), pb = Math.round(r.l / 10);
          return `<div class="eval-row${best}">` +
            `<span class="eval-san">${r.san}</span>` +
            `<span class="eval-bars"><span class="w" style="width:${(r.w / 10).toFixed(1)}%"></span><span class="d" style="width:${(r.d / 10).toFixed(1)}%"></span><span class="b" style="width:${(r.l / 10).toFixed(1)}%"></span></span>` +
            `<span class="eval-pct">${pw} · ${pd} · ${pb}</span>` +
            `</div>`;
        }
        const cp = r.cpWhite;
        const cpText = (cp >= 0 ? '+' : '') + (cp / 100).toFixed(1);
        const share = (1 / (1 + Math.exp(-0.00368208 * cp))) * 100;
        return `<div class="eval-row${best}">` +
          `<span class="eval-san">${r.san}</span>` +
          `<span class="eval-bars"><span class="w" style="width:${share.toFixed(1)}%"></span><span class="b" style="width:${(100 - share).toFixed(1)}%"></span></span>` +
          `<span class="eval-pct">${cpText}</span>` +
          `</div>`;
      }).join('');
    }

    /* ----- AI 流程：轮到 AI 时自动思考并落子 ----- */
    aiColor() { return other(this.humanColor); }

    scheduleAI() {
      if (this.editing) return;
      if (this.mode !== 'ai' || this.aiBroken) return;
      if (this.st.over || this.game.turn() === this.humanColor) return;
      if (this.aiThinking || this.aiBooting || this.aiScheduled) return;
      this.aiScheduled = true;
      setTimeout(() => { this.aiScheduled = false; this.runAI(); }, 380);   // 等走子动画结束
    }

    async runAI() {
      if (this.editing || this.mode !== 'ai' || this.st.over || this.game.turn() === this.humanColor) return;
      const epoch = this.epoch;
      const level = AI_LEVELS[this.aiLevel];
      try {
        if (!this.engine) this.engine = new Engine();
        if (!this.engine.ready) {
          this.aiBooting = true;
          this.refresh();
          await this.engine.init();
          this.aiBooting = false;
          if (this.epoch !== epoch) { this.refresh(); return; }   // 启动期间被重开/悔棋
        }
        this.aiThinking = true;
        this.refresh();                                            // 锁盘 + “思考中…”
        const mv = await this.engine.think(this.game.fen(), level);
        this.aiThinking = false;
        if (this.epoch !== epoch) { this.refresh(); return; }      // 结果过期，丢弃
        if (!mv) { toast('AI 未返回走法'); this.refresh(); return; }
        this.executeMove(mv.from, mv.to, mv.promotion);
      } catch (err) {
        this.aiThinking = false;
        this.aiBooting = false;
        if (this.epoch !== epoch) { this.refresh(); return; }
        this.aiBroken = true;                                      // 避免失败循环
        console.error('[AI]', err);
        toast('AI 引擎出错：' + (err && err.message ? err.message : '未知错误'));
        this.refresh();
      }
    }

    /* ----- 控制动作 ----- */
    undo() {
      if (this.editing) return false;
      if (this.promotionPending) this.closePromotion();
      this.viewPly = null;                                     // 悔棋作用于实时棋局
      this.deviatePly = null;
      if (!this.game.history().length) return false;
      if (this.aiThinking) { this.engine?.cancel(); this.aiThinking = false; }
      this.epoch++;                                            // 丢弃在途的 AI 结果
      this.game.undo();
      if (this.mode === 'ai') {
        // 人机模式：一直撤到轮到人类走（通常一次撤两步：AI 的 + 你的）
        while (this.game.history().length && this.game.turn() !== this.humanColor) {
          this.game.undo();
        }
      }
      this.view.clearSelection();
      this.view.renderAll(this.game.fen());
      this.refresh();
      return true;
    }

    flip() {
      if (this.promotionPending) this.closePromotion();
      this.view.clearSelection();
      this.view.setOrientation(other(this.view.orientation));
      this.refresh();
    }

    /**
     * 开新局。不传参数时沿用当前设置（重新开始 / 再来一局）。
     * opts: { mode: 'pvp'|'ai', humanColor, aiLevel, orientation }
     */
    newGame(opts = {}) {
      if (this.editing) this._exitEditUI();
      if (this.promotionPending) this.closePromotion();
      this.epoch++;
      this.aiThinking = false;
      this.aiBooting = false;
      this.aiScheduled = false;
      this.aiBroken = false;
      this.engine?.cancel();                                   // 停掉旧搜索（结果按代际丢弃）

      const s = {
        mode: opts.mode ?? this.settings.mode,
        humanColor: opts.humanColor ?? this.settings.humanColor,
        aiLevel: opts.aiLevel ?? this.settings.aiLevel,
        orientation: opts.orientation ?? this.settings.orientation,
      };
      this.settings = s;
      this.mode = s.mode;
      this.humanColor = s.humanColor;
      this.aiLevel = s.aiLevel;

      this.game.reset();
      this.importedPgn = null;
      this.playerNames = { w: '', b: '' };
      this.viewPly = null;
      this.deviatePly = null;
      this.st = this.game.status();
      if (this.engine?.ready) this.engine.newGame();
      this.view.clearSelection();
      this.view.setOrientation(s.orientation, { animate: false });
      this.view.renderAll(this.game.fen());
      this.refresh();                                          // AI 执白时将自动开想
    }

    loadFen(fen) {
      if (this.editing) this._exitEditUI();
      if (this.promotionPending) this.closePromotion();
      if (this.aiThinking) { this.engine?.cancel(); this.aiThinking = false; }
      this.epoch++;
      this.viewPly = null;
      this.deviatePly = null;
      this.importedPgn = null;
      this.playerNames = { w: '', b: '' };
      if (!this.game.loadFen(fen)) { toast('无效的 FEN'); this.refresh(); return false; }
      this.st = this.game.status();
      this.view.clearSelection();
      this.view.renderAll(this.game.fen());
      this.refresh();
      return true;
    }

    /* ----- PGN：导入 / 导出 ----- */
    /** 导出当前棋局的 PGN；导入棋谱分叉时保留原头信息，仅 Result 跟随最新局面 */
    buildPgn() {
      if (this.importedPgn) {
        this.game.setHeader('Result', this.st.result);
        let out = this.game.pgnBody().trim();          // 原始头信息 + 当前走法序列
        out = out.replace(/\s*(\*|1-0|0-1|1\/2-1\/2)\s*$/, '').trim();
        if (out && !out.endsWith(']')) out += ` ${this.st.result}`;
        return out ? out + '\n' : '';
      }
      const d = new Date();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const levelName = AI_LEVELS[this.aiLevel].name;
      const [wName, bName] = this.mode === 'ai'
        ? (this.humanColor === 'w' ? ['玩家', `AI·${levelName}`] : [`AI·${levelName}`, '玩家'])
        : ['白方', '黑方'];
      const headers = [
        '[Event "休闲对局"]',
        '[Site "Online Chess (offline)"]',
        `[Date "${d.getFullYear()}.${mm}.${dd}"]`,
        '[Round "-"]',
        `[White "${wName}"]`,
        `[Black "${bName}"]`,
        `[Result "${this.st.result}"]`,
      ];
      // 自定义开局（编辑器 / 导入 FEN）：保留 SetUp/FEN 头，否则导出的棋谱无法还原
      const setFen = this.game.header('FEN');
      if (this.game.header('SetUp') === '1' && setFen) {
        headers.push('[SetUp "1"]', `[FEN "${setFen}"]`);
      }
      const headerText = headers.join('\n');
      let body = this.game.pgnBody().trim();
      body = body.replace(/^\[.*\]\s*$/gm, '').trim();   // 防御性去掉库内可能存在的头
      body = body.replace(/\s*\*\s*$/, '').trim();       // 去掉结尾的 *
      if (!body) return `${headerText}\n`;
      return `${headerText}\n\n${body} ${this.st.result}\n`;
    }

    openPgn() {
      if (this.editing) { toast('请先完成或取消局面编辑'); return; }
      if (this.promotionPending) this.closePromotion();
      this._pgnView = 'new';
      $('#pgnModal').hidden = false;
      this._renderPgnModal();
    }

    _renderPgnModal() {
      const hasOrig = !!this.importedPgn;
      $('#pgnTabs').hidden = !hasOrig;
      $('#pgnTabNew').classList.toggle('active', this._pgnView === 'new');
      $('#pgnTabOrig').classList.toggle('active', this._pgnView === 'orig');
      $('#pgnText').value = this._pgnView === 'orig' ? this.importedPgn : this.buildPgn();
    }

    /* ----- PGN 导入 ----- */
    openImport() {
      if (this.promotionPending) this.closePromotion();
      $('#importError').hidden = true;
      $('#importModal').hidden = false;
      setTimeout(() => $('#importText').focus({ preventScroll: true }), 50);
    }

    doImport() {
      const text = $('#importText').value.trim();
      const errEl = $('#importError');
      if (!text) {
        errEl.textContent = '请先粘贴 PGN 文本或选择 .pgn 文件';
        errEl.hidden = false;
        return;
      }
      if (!this.loadPgnGame(text)) {
        errEl.textContent = '无法解析这份 PGN（未识别到走子序列），请检查内容格式';
        errEl.hidden = false;
        return;
      }
      $('#importModal').hidden = true;
      toast('棋谱已导入 · 点击走子记录可回看任意局面');
    }

    /** 导入 PGN 成棋局（双人模式，可回看、可分叉试走）；原始文本保留用于原样导出 */
    loadPgnGame(text) {
      const probe = new Chess();
      let ok = false;
      try { ok = probe.load_pgn(text, { sloppy: true }); } catch { ok = false; }
      if (!ok || probe.history().length === 0) return false;

      if (this.promotionPending) this.closePromotion();
      if (this.editing) this._exitEditUI();
      this.epoch++;
      this.aiThinking = false;
      this.aiBooting = false;
      this.aiScheduled = false;
      this.aiBroken = false;
      this.engine?.cancel();
      this.mode = 'pvp';
      this.settings.mode = 'pvp';
      this.viewPly = null;
      this.deviatePly = null;
      this.importedPgn = text;
      this.playerNames = {
        w: (probe.header() && probe.header().White) || '',
        b: (probe.header() && probe.header().Black) || '',
      };

      this.game = new Game();
      this.game.loadPgn(text);
      this.st = this.game.status();
      if (this.engine?.ready) this.engine.newGame();
      this.view.clearSelection();
      this.view.renderAll(this.game.fen());
      this.refresh();
      return true;
    }

    /* ----- 局面编辑器：自由摆子 / 清空 / 导入 FEN ----- */
    editorFen() { return fenFromMap(this.editor.map, this.editor.turn); }

    enterEdit() {
      if (this.promotionPending) this.closePromotion();
      if (this.aiThinking) { this.engine?.cancel(); this.aiThinking = false; }
      this.epoch++;
      this.viewPly = null;
      this.deviatePly = null;
      this.editor.map = this.game.mapPieces();     // 默认从当前实时局面开始编辑
      this.editor.turn = this.game.turn();
      this.editor.pick = null;
      this.editing = true;
      this.view.setEditMode(true);
      this.view.clearSelection();
      $('#editorCard').hidden = false;
      $('#btnEdit').textContent = '退出编辑';
      this.banner.hide();
      this.analysis.setPosition(null);             // 暂停局面分析
      $('#evalMeta').textContent = '编辑模式';
      $('#evalMoves').innerHTML = '<div class="moves-empty">编辑中…完成编辑后恢复分析</div>';
      this._renderEditorUI();
      this.refresh();                              // 走编辑分支：渲染编辑局面 + 状态卡
    }

    _exitEditUI() {
      this.editing = false;
      this.editor.pick = null;
      this.view.setEditMode(false);
      this.view.clearSelection();
      $('#editorCard').hidden = true;
      $('#btnEdit').textContent = '编辑局面';
    }

    finishEdit() {
      const fen = this.editorFen();
      const err = this._validateEditFen(fen);
      if (err) { toast(err); return false; }
      this._exitEditUI();
      this.loadFen(fen);                            // 作为新棋局开始（保留当前模式）
      toast('已从编辑局面开始对局');
      return true;
    }

    cancelEdit() {
      this._exitEditUI();
      this.view.renderAll(this.game.fen());
      this.refresh();
    }

    /** 编辑器调色板点击：拾取 / 取消拾取 */
    pickPiece(code) {
      this.editor.pick = this.editor.pick === code ? null : code;
      this._renderEditorUI();
    }

    setEditTurn(t) {
      this.editor.turn = t;
      this._renderEditorUI();
    }

    editPlace(code, sq) {
      if (this.editor.map[sq] === code) return;
      if (this.editor.map[sq]) this.view.removePiece(sq);
      this.editor.map[sq] = code;
      this.view.setPiece(sq, code);
      this._afterEditChange();
    }

    editErase(sq) {
      if (!this.editor.map[sq]) return;
      delete this.editor.map[sq];
      this.view.removePiece(sq);
      this._afterEditChange();
    }

    editMove(from, to) {
      const code = this.editor.map[from];
      if (!code || from === to) return;
      if (this.editor.map[to]) this.view.removePiece(to);
      delete this.editor.map[from];
      this.editor.map[to] = code;
      this.view.movePieceEl(from, to);
      this._afterEditChange();
    }

    /** 一键更换编辑基底：清空 / 标准开局 / 回到当前实时局面 */
    loadEditBase(kind) {
      if (kind === 'clear') {
        this.editor.map = {};
      } else if (kind === 'standard') {
        this.editor.map = mapFromBoard(new Chess());
      } else {
        this.editor.map = this.game.mapPieces();
        this.editor.turn = this.game.turn();
      }
      this.view.clearSelection();
      this.view.renderAll(this.editorFen());
      this._afterEditChange();
    }

    /** 从输入框导入 FEN 到编辑器 */
    applyEditFen() {
      const fen = normalizeFen($('#editFen').value);
      if (!fen) { toast('无效的 FEN（棋盘部分格式不正确）'); return; }
      const c = new Chess();
      c.load(fen);
      this.editor.map = mapFromBoard(c);
      this.editor.turn = c.turn();
      this.view.clearSelection();
      this.view.renderAll(this.editorFen());
      this._afterEditChange();
    }

    _validateEditFen(fen) {
      const map = this.editor.map;
      const wk = Object.values(map).filter((c) => c === 'wK').length;
      const bk = Object.values(map).filter((c) => c === 'bK').length;
      if (wk !== 1) return '编辑未完成：白方需要恰好一个王';
      if (bk !== 1) return '编辑未完成：黑方需要恰好一个王';
      for (const sq of Object.keys(map)) {
        if (map[sq][1] === 'P' && (sq[1] === '1' || sq[1] === '8')) return '编辑未完成：兵不能放在第 1 / 8 横排';
      }
      // 轮走方不能已经将军对方王（否则该局面非法）
      const parts = fen.split(' ');
      parts[1] = other(this.editor.turn);
      const probe = new Chess();
      if (probe.load(parts.join(' ')) && probe.in_check()) return '编辑未完成：当前行棋方已将军对方王，请切换行棋方';
      return null;
    }

    _afterEditChange() {
      const map = this.editor.map;
      const wk = Object.values(map).filter((c) => c === 'wK').length;
      const bk = Object.values(map).filter((c) => c === 'bK').length;
      $('#editKings').textContent = `白王 ${wk} · 黑王 ${bk}`;
      $('#editKings').classList.toggle('bad', wk !== 1 || bk !== 1);
      const fenEl = $('#editFen');
      if (document.activeElement !== fenEl) fenEl.value = this.editorFen();
    }

    _renderEditorUI() {
      const pal = $('#editPalette');
      pal.innerHTML = '';
      for (const code of ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP']) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pal' + (this.editor.pick === code ? ' on' : '');
        btn.dataset.code = code;
        btn.title = colorName(code[0]) + PIECE_ZH[code[1].toLowerCase()];
        btn.innerHTML = PIECE_SVG[code];
        pal.appendChild(btn);
      }
      const eraser = document.createElement('button');
      eraser.type = 'button';
      eraser.className = 'pal pal-eraser' + (this.editor.pick === 'erase' ? ' on' : '');
      eraser.dataset.code = 'erase';
      eraser.title = '删除工具：点击棋盘上的棋子将其移除（也可右键删除 / 拖出棋盘）';
      eraser.textContent = '✕';
      pal.appendChild(eraser);

      document.querySelectorAll('[data-seg="edit-turn"] .seg-btn').forEach((b) => {
        b.classList.toggle('on', b.dataset.value === this.editor.turn);
      });
      this._afterEditChange();
    }

    /* ----- 沉浸模式：隐藏页面其余部分，只留棋盘 ----- */
    toggleImmersive(on) {
      this.immersive = !!on;
      document.body.classList.toggle('immersive', this.immersive);
    }

    /* ----- 控件绑定 ----- */
    _bindControls() {
      $('#btnUndo').addEventListener('click', () => this.undo());
      $('#btnFlip').addEventListener('click', () => this.flip());
      $('#btnRestart').addEventListener('click', () => this.newGame());
      $('#btnNew').addEventListener('click', () => this.newDialog.open());
      $('#btnPgn').addEventListener('click', () => this.openPgn());
      $('#btnImportPgn').addEventListener('click', () => this.openImport());
      $('#btnEdit').addEventListener('click', () => (this.editing ? this.cancelEdit() : this.enterEdit()));
      $('#btnLatest').addEventListener('click', () => this.gotoPly(this.game.history().length));

      // 局面编辑器
      $('#editPalette').addEventListener('click', (e) => {
        const b = e.target.closest('.pal');
        if (b) this.pickPiece(b.dataset.code);
      });
      document.querySelectorAll('[data-seg="edit-turn"] .seg-btn').forEach((b) => {
        b.addEventListener('click', () => this.setEditTurn(b.dataset.value));
      });
      $('#editClear').addEventListener('click', () => this.loadEditBase('clear'));
      $('#editStandard').addEventListener('click', () => this.loadEditBase('standard'));
      $('#editCurrent').addEventListener('click', () => this.loadEditBase('current'));
      $('#editApplyFen').addEventListener('click', () => this.applyEditFen());
      $('#editFen').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.applyEditFen(); } });
      $('#editDone').addEventListener('click', () => this.finishEdit());
      $('#editCancel').addEventListener('click', () => this.cancelEdit());

      // 沉浸模式（只显示棋盘）
      $('#btnImmersive').addEventListener('click', () => this.toggleImmersive(true));
      $('#exitImmersive').addEventListener('click', () => this.toggleImmersive(false));

      // 走法胜率 / 左侧胜率条显示开关（胜率条默认关闭）
      $('#tglMoves').addEventListener('change', (e) =>
        document.body.classList.toggle('eval-off', !e.target.checked));
      $('#tglBar').addEventListener('change', (e) =>
        document.body.classList.toggle('bar-off', !e.target.checked));
      document.body.classList.toggle('bar-off', !$('#tglBar').checked);
      document.body.classList.toggle('eval-off', !$('#tglMoves').checked);

      $('#btnCopyFen').addEventListener('click', () =>
        copyText(this.editing ? this.editorFen() : this.pos.fen(), 'FEN 已复制'));

      $('#pgnCopy').addEventListener('click', () => copyText($('#pgnText').value, 'PGN 已复制'));
      $('#pgnDownload').addEventListener('click', () =>
        downloadText(this._pgnView === 'orig' ? 'chess-imported.pgn' : 'chess-game.pgn', $('#pgnText').value));
      $('#pgnClose').addEventListener('click', () => { $('#pgnModal').hidden = true; });
      $('#pgnModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#pgnModal').hidden = true; });
      $('#pgnTabNew').addEventListener('click', () => { this._pgnView = 'new'; this._renderPgnModal(); });
      $('#pgnTabOrig').addEventListener('click', () => { this._pgnView = 'orig'; this._renderPgnModal(); });

      $('#importConfirm').addEventListener('click', () => this.doImport());
      $('#importCancel').addEventListener('click', () => { $('#importModal').hidden = true; });
      $('#importModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#importModal').hidden = true; });
      $('#importFile').addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => { $('#importText').value = String(r.result || ''); };
        r.readAsText(f);
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (this.promotionPending) return this.cancelPromotion();
          const anyModal = !$('#newModal').hidden || !$('#pgnModal').hidden || !$('#importModal').hidden;
          if (anyModal) {
            this.newDialog.close();
            $('#pgnModal').hidden = true;
            $('#importModal').hidden = true;
            return;
          }
          if (this.editing) return this.cancelEdit();
          if (this.immersive) this.toggleImmersive(false);
          return;
        }
        // ←/→/Home/End 回看走子记录
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        if (e.target.closest && e.target.closest('input, textarea, select')) return;
        if (!$('#newModal').hidden || !$('#pgnModal').hidden || !$('#importModal').hidden || this.promotionPending) return;
        const n = this.game.history().length;
        if (!n) return;
        const cur = this.viewPly === null ? n : this.viewPly;
        e.preventDefault();
        if (e.key === 'ArrowLeft' && cur > 0) this.gotoPly(cur - 1);
        else if (e.key === 'ArrowRight' && cur < n) this.gotoPly(cur + 1);
        else if (e.key === 'Home') this.gotoPly(0);
        else if (e.key === 'End') this.gotoPly(n);
      });
    }
  }

  /* ---------- 启动 ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new App());
  } else {
    new App();
  }
})();
