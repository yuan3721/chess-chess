#!/usr/bin/env node
/**
 * Online Chess — 单文件构建脚本
 *
 * 把 src/ 下的源码与 vendor/ 下的依赖内联为一个可直接打开的 index.html：
 *   - vendor/chess.js                     chess.js 0.13.4（BSD-2-Clause）
 *   - vendor/pieces/*.svg                 cburnett 棋子（CC-BY-SA 3.0，via lichess）
 *   - vendor/engine/stockfish-19-lite-*   Stockfish 19 Lite WASM（GPLv3）
 *
 * 用法：node tools/build.mjs
 * 无任何第三方依赖，仅需 Node.js。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const shell = read('src/shell.html');
const style = read('src/style.css');
const app = read('src/app.js');

// chess.js 0.13.4 的源码是 ESM：去掉行首 `export ` 关键字后是普通脚本，
// 包进 IIFE 并挂到 window.Chess，即可在浏览器 <script> 中离线运行。
const chessRaw = read('vendor/chess.js').replace(/^export /gm, '');
const chess =
  '/* chess.js 0.13.4 — Copyright (c) 2022 Jeff Hlywa (BSD-2-Clause) — https://github.com/jhlywa/chess.js */\n' +
  ';(function () {\n' + chessRaw + '\nwindow.Chess = Chess;\n})();';

// 12 枚棋子 SVG → 常量表
const codes = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
const pieces =
  '/* 棋子图形：cburnett SVG by Colin M.L. Burnett（CC-BY-SA 3.0）via lichess */\n' +
  'const PIECE_SVG = {\n' +
  codes.map((c) => `  ${c}: ${JSON.stringify(read(`vendor/pieces/${c}.svg`).trim())}`).join(',\n') +
  '\n};';

// Stockfish 19 Lite（单线程 WASM，小网络内嵌，GPLv3）
// 运行时由 app.js 还原为 Blob URL 注入 Worker，因此单文件可离线运行。
const engineGlue = read('vendor/engine/stockfish-19-lite-single.js');
const engineWasm = readFileSync(path.join(root, 'vendor/engine/stockfish-19-lite-single.wasm')).toString('base64');
const engine =
  '/* Stockfish 19 Lite WASM (single-threaded) — GPLv3 — https://github.com/nmrugg/stockfish.js */\n' +
  'const ENGINE_GLUE = ' + JSON.stringify(engineGlue) + ';\n' +
  'const ENGINE_WASM_B64 = ' + JSON.stringify(engineWasm) + ';';

// 黑马作为 favicon（data URI）
const favicon = 'data:image/svg+xml,' + encodeURIComponent(read('vendor/pieces/bN.svg').trim());

// 用函数替换，避免内容中的 $& 等序列被当作替换模式
const html = shell
  .replace('__FAVICON__', () => favicon)
  .replace('/*__STYLE__*/', () => style)
  .replace('/*__CHESS_JS__*/', () => chess)
  .replace('/*__PIECES__*/', () => pieces)
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__APP__*/', () => app);

writeFileSync(path.join(root, 'index.html'), html);
console.log(`index.html 已生成：${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
