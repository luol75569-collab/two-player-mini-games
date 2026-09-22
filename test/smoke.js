#!/usr/bin/env node
'use strict';

/**
 * game-hub 冒烟测试
 *
 * 目的：一条命令验证「服务端权威 + 汤底不下发给猜题者 + 房间上限 2 人 + 离线可跑」这些红线没被改坏。
 * 依赖：只用 Node 内置模块 + 项目已有的 ws，零额外依赖。
 * 运行：npm test
 *
 * 设计约定：
 * - 自动在「随机空闲端口」拉起 server.js 子进程，绝不碰 3000（那是用户在用的服务）。
 * - 无论成功、失败还是超时，都会在 finally / process 事件里杀掉子进程，不留残余。
 * - 每条消息等待都有上限（WAIT_MS），整体还有总超时（TOTAL_MS），不会永久挂起。
 * - 失败以非 0 退出码结束。
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');

const WAIT_MS = 4000; // 单条消息等待上限
const READY_MS = 15000; // 服务器启动等待上限
const TOTAL_MS = 90000; // 整体兜底

// ---------- 结果输出 / 断言计数 ----------
let passed = 0;
const failures = [];

function section(text) {
  console.log(`\n${text}`);
}

function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ❌ ${label}`);
    if (detail) console.log(`       ↳ ${detail}`);
  }
}

function note(text) {
  console.log(`  ℹ️  ${text}`);
}

function warn(text) {
  console.log(`  ⚠️  ${text}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- WebSocket 测试客户端 ----------
/**
 * 说明：本测试是串行执行的（await 完一个断言再发下一个刺激），
 * 所以同一时刻每个客户端最多只有一个等待中的 waiter，逻辑保持简单。
 */
class TestClient {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.messages = []; // 解析后的消息
    this.rawTexts = []; // 原始文本，用于「汤底有没有被发出去」的检查
    this.cursor = 0; // 已被消费到的位置
    this.waiters = [];
    ws.on('message', (data) => this._onMessage(data.toString()));
    ws.on('error', () => { /* 连接错误由断言超时兜底 */ });
  }

  _onMessage(text) {
    this.rawTexts.push(text);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return;
    }
    this.messages.push(msg);
    const waiter = this.waiters[0];
    if (waiter && waiter.pred(msg)) {
      this.waiters.shift();
      this.cursor = this.messages.length;
      waiter.resolve(msg);
    }
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** 等待下一条满足 pred 的消息；超时抛错（会让测试以非 0 退出） */
  waitFor(pred, label = '消息', timeout = WAIT_MS) {
    for (let i = this.cursor; i < this.messages.length; i++) {
      if (pred(this.messages[i])) {
        this.cursor = i + 1;
        return Promise.resolve(this.messages[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        const seen = this.messages.map((m) => m.type).join(', ') || '（啥都没收到）';
        reject(new Error(`[${this.label}] 等待「${label}」超时（${timeout}ms）。已收到的消息类型：${seen}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  types() {
    return this.messages.map((m) => m.type);
  }

  destroy() {
    try {
      this.ws.terminate();
    } catch (_) { /* ignore */ }
  }
}

// ---------- 进程 / 网络工具 ----------
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

let serverChild = null;
let serverLog = '';

async function startServer(port) {
  serverLog = '';
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild = child;
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server.js 提前退出（code=${child.exitCode}）：\n${serverLog}`);
    }
    const info = await httpGet(port, '/api/info');
    if (info && info.status === 200) return child;
    await sleep(100);
  }
  throw new Error(`server.js 在 ${READY_MS}ms 内没有就绪：\n${serverLog}`);
}

/** 确保子进程被杀掉：SIGTERM → 1.5s 后 SIGKILL */
function killServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch (_) { done(); }
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
      setTimeout(done, 300);
    }, 1500);
  });
}

// 兜底：任何情况下进程退出前，先杀掉我们拉起的子进程（绝不动别人的 node）
process.on('exit', () => {
  if (serverChild && serverChild.exitCode === null) {
    try { serverChild.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (serverChild && serverChild.exitCode === null) {
      try { serverChild.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
    process.exit(1);
  });
}

// ---------- 断言辅助 ----------
async function connectClient(port, label) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const client = new TestClient(ws, label);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[${label}] WebSocket 连接超时`)), WAIT_MS);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
  const welcome = await client.waitFor((m) => m.type === 'welcome', 'welcome');
  return { c: client, welcome, label };
}

/** 期望收到一条包含 substr 的 error */
async function expectError(client, substr, label) {
  const msg = await client.waitFor(
    (m) => m.type === 'error' && String(m.message || '').includes(substr),
    label,
  );
  check(true, `${label} → 服务端回「${msg.message}」`);
  return msg;
}

/** 落子并等到「双方」的状态都更新（保证串行、无竞态） */
async function playMove(mover, other, x, y) {
  mover.c.send({ type: 'gomoku_move', x, y });
  const mine = await mover.c.waitFor((m) => m.type === 'gomoku_state', `落子(${x},${y})后本方状态`);
  const theirs = await other.c.waitFor((m) => m.type === 'gomoku_state', `落子(${x},${y})后对方状态`);
  return [mine, theirs];
}

// ---------- 主流程 ----------
async function main() {
  console.log('=== game-hub 冒烟测试 ===');

  const port = await pickFreePort();
  if (port === 3000) throw new Error('拿到 3000 端口，拒绝使用（那是用户正在跑的服务）');
  note(`使用随机空闲端口 ${port}，启动 server.js 子进程`);

  const child = await startServer(port);
  note(`服务已就绪：http://127.0.0.1:${port}`);

  const clients = [];
  try {
    // ================= 1. 房间与人数上限 =================
    section('【1】房间：4 位房间号 / 2 人上限 / 第三人被拒');

    const a = await connectClient(port, '玩家A');
    clients.push(a.c);
    check(Number.isInteger(a.welcome.playerId), '连接后收到 welcome 并分配 playerId');

    a.c.send({ type: 'create_room', name: '甲' });
    const roomA = await a.c.waitFor((m) => m.type === 'room_update', 'room_update（创建房间）');
    check(/^\d{4}$/.test(String(roomA.code)), `创建房间返回 4 位数字房间号（${roomA.code}）`);
    check(roomA.players.length === 1 && roomA.game === null, '创建后房间里只有 1 人，且还没选游戏');

    const b = await connectClient(port, '玩家B');
    clients.push(b.c);
    b.c.send({ type: 'join_room', code: roomA.code, name: '乙' });
    const roomB = await b.c.waitFor((m) => m.type === 'room_update', 'room_update（加入房间）');
    check(roomB.players.length === 2, '第二名玩家用房间号加入成功，房间内 2 人');
    const roomA2 = await a.c.waitFor(
      (m) => m.type === 'room_update' && m.players.length === 2,
      'room_update（原玩家看到 2 人）',
    );
    check(roomA2.players.length === 2, '房主同步看到第二名玩家进房');

    const c3 = await connectClient(port, '玩家C');
    clients.push(c3.c);
    c3.c.send({ type: 'join_room', code: roomA.code, name: '丙' });
    await expectError(c3.c, '已满', '第三名玩家加入被拒绝（房间上限 2 人）');
    check(!c3.c.types().includes('room_update'), '被拒绝的第三人没有进入房间（未收到 room_update）');
    await sleep(300);
    const roomUpdates = a.c.messages.filter((m) => m.type === 'room_update');
    check(
      roomUpdates.length > 0 &&
        roomUpdates[roomUpdates.length - 1].players.length === 2 &&
        roomUpdates.every((m) => m.players.length <= 2),
      '第三人尝试加入后，房主看到的人数上限没有被突破（最后一次更新仍是 2 人）',
    );

    c3.c.send({ type: 'join_room', code: '0000', name: '丙' });
    await expectError(c3.c, '不存在', '加入不存在的房间号被拒绝');

    // ================= 2. 五子棋 =================
    section('【2】五子棋：落子、轮次、胜负全部服务端权威');

    a.c.send({ type: 'select_game', game: 'gomoku' });
    const gA = await a.c.waitFor((m) => m.type === 'gomoku_state', 'gomoku_state（A）');
    const gB = await b.c.waitFor((m) => m.type === 'gomoku_state', 'gomoku_state（B）');
    check(gA.board.length === 225 && gA.board.every((v) => v === 0), '开局棋盘 15×15=225 格且全空');
    check(gA.size === 15, '服务端下发棋盘尺寸为 15');
    check(
      [1, 2].includes(gA.youColor) && [1, 2].includes(gB.youColor) && gA.youColor !== gB.youColor,
      '双方拿到不同颜色（youColor 分别为 1 和 2）',
    );
    check(gA.turn === 1 && gB.turn === 1, '开局 turn=1（黑先），双方一致');
    check(gA.winner === null && gA.moveCount === 0, '开局无胜者、落子数为 0');

    const black = gA.youColor === 1 ? a : b;
    const white = black === a ? b : a;
    note(`随机分配：${black.label} 执黑先手，${white.label} 执白`);

    white.c.send({ type: 'gomoku_move', x: 7, y: 7 });
    await expectError(white.c, '轮到', '不是自己的回合落子被拒绝');

    black.c.send({ type: 'gomoku_move', x: 99, y: 99 });
    await expectError(black.c, '非法', '越界落子（99,99）被拒绝');

    black.c.send({ type: 'gomoku_move', x: 1.5, y: 2 });
    await expectError(black.c, '非法', '非整数坐标落子被拒绝');

    const [m1, m1Other] = await playMove(black, white, 7, 7);
    check(m1.board[7 * 15 + 7] === 1 && m1Other.board[7 * 15 + 7] === 1, '黑方落子 (7,7) 同步到两个客户端');
    check(m1.turn === 2 && m1Other.turn === 2, '落子后轮次切到白方，双方一致');
    check(JSON.stringify(m1.board) === JSON.stringify(m1Other.board), '两个客户端收到的棋盘完全相同');
    check(m1.moveCount === 1, '服务端落子计数为 1');

    black.c.send({ type: 'gomoku_move', x: 8, y: 8 });
    await expectError(black.c, '轮到', '黑方连下第二手被拒绝（轮次由服务端把控）');

    white.c.send({ type: 'gomoku_move', x: 7, y: 7 });
    await expectError(white.c, '已经有棋子', '落在已占位置被拒绝');

    // 黑方凑五连：白方用 (0,1)..(3,1) 陪跑，(14,14) 是为了不让白方先成五连
    const winSeq = [
      [white, 0, 1], [black, 0, 0],
      [white, 1, 1], [black, 1, 0],
      [white, 2, 1], [black, 2, 0],
      [white, 3, 1], [black, 3, 0],
      [white, 14, 14], [black, 4, 0],
    ];
    let lastPair = null;
    for (const [mover, x, y] of winSeq) {
      lastPair = await playMove(mover, mover === black ? white : black, x, y);
    }
    const [winBlack, winWhite] = lastPair;
    check(winBlack.winner === 1 && winWhite.winner === 1, '黑方五连后服务端判定 winner=1 并广播给双方');
    check(
      Array.isArray(winBlack.winningLine) && winBlack.winningLine.length >= 5,
      `服务端返回五连连线坐标（${(winBlack.winningLine || []).length} 个点）`,
    );
    check(
      JSON.stringify(winBlack.winningLine) === JSON.stringify(winWhite.winningLine) &&
        JSON.stringify(winBlack.board) === JSON.stringify(winWhite.board),
      '胜负与棋盘在双方之间完全一致',
    );
    check(
      (winBlack.winningLine || []).every(([x, y]) => winBlack.board[y * 15 + x] === 1),
      '五连连线上的格子确实都是黑子',
    );
    check(
      winBlack.moveCount === winBlack.board.filter((v) => v !== 0).length,
      '服务端落子数等于棋盘上的棋子数（没有重复落子）',
    );

    black.c.send({ type: 'gomoku_move', x: 5, y: 0 });
    await expectError(black.c, '结束', '胜局结束后继续落子被拒绝');

    a.c.send({ type: 'restart' });
    const rA = await a.c.waitFor((m) => m.type === 'gomoku_state', '重开后的状态（A）');
    const rB = await b.c.waitFor((m) => m.type === 'gomoku_state', '重开后的状态（B）');
    check(
      rA.winner === null && rA.moveCount === 0 && rA.board.every((v) => v === 0) &&
        rB.winner === null && rB.board.every((v) => v === 0),
      '「再来一局」由服务端重置棋盘与胜负状态',
    );

    // ================= 3. 海龟汤：汤底可见性 =================
    section('【3】海龟汤：汤底只给汤主');

    a.c.send({ type: 'select_game', game: 'soup' });
    const sHost = await a.c.waitFor((m) => m.type === 'soup_state', 'soup_state（汤主）');
    const sGuess = await b.c.waitFor((m) => m.type === 'soup_state', 'soup_state（猜题者）');
    check(sHost.isHost === true && sGuess.isHost === false, 'A 是汤主、B 是猜题者（角色由服务端标注）');
    check(
      typeof sHost.answer === 'string' && sHost.answer.length > 0,
      `汤主收到的 soup_state 里有汤底（${String(sHost.answer).length} 字）`,
    );
    check(sGuess.answer === null, '猜题者收到的 soup_state 里 answer 为 null');
    check(
      typeof sGuess.surface === 'string' && sGuess.surface.length > 0 && sGuess.surface === sHost.surface,
      '汤面双方都能看到且内容一致',
    );

    const answer = sHost.answer;
    const leaked = b.c.rawTexts.filter((t) => t.includes(answer));
    check(
      leaked.length === 0,
      '猜题者收到的「全部原始消息文本」中都不含汤底内容',
      leaked.length ? `泄漏 ${leaked.length} 条，首条：${leaked[0].slice(0, 140)}…` : '',
    );
    check(
      Array.isArray(sGuess.hints) && sGuess.hints.length === 0,
      '猜题者收到的 soup_state 里 hints 为空（提示与汤底同一道安全边界）',
      `实际 hints=${JSON.stringify(sGuess.hints)}`,
    );
    const hostHints = Array.isArray(sHost.hints) ? sHost.hints : [];
    check(
      hostHints.every((h) => typeof h === 'string'),
      '汤主收到的 hints 是字符串数组（题有提示时汤主可用）',
    );
    const hintLeak = hostHints.filter((h) => h && b.c.rawTexts.some((t) => t.includes(h)));
    check(
      hintLeak.length === 0,
      '猜题者收到的「全部原始消息文本」中都不含汤主提示内容',
      hintLeak.length ? `泄漏 ${hintLeak.length} 条提示` : '',
    );

    b.c.send({ type: 'soup_answer', answer: 'yes' });
    await expectError(b.c, '汤主', '非汤主调用 soup_answer 被拒绝');

    a.c.send({ type: 'soup_question', text: '这是谋杀吗？' });
    await expectError(a.c, '猜题者', '非猜题者调用 soup_question 被拒绝');

    b.c.send({ type: 'soup_start' });
    await expectError(b.c, '汤主', '非汤主调用 soup_start 被拒绝');

    const qText = '死者是被谋杀的，对吗？';
    b.c.send({ type: 'soup_question', text: qText });
    const qHost = await a.c.waitFor(
      (m) => m.type === 'soup_state' && m.lastQuestion,
      '提问广播（汤主）',
    );
    const qGuess = await b.c.waitFor(
      (m) => m.type === 'soup_state' && m.lastQuestion,
      '提问广播（猜题者）',
    );
    check(
      qHost.lastQuestion.text === qText && qGuess.lastQuestion.text === qText &&
        qGuess.lastQuestion.answer === null,
      '猜题者提问被广播给双方，且还未回答',
    );

    a.c.send({ type: 'soup_answer', answer: 'maybe' });
    await expectError(a.c, '非法回答', '非法的回答枚举值被拒绝');

    a.c.send({ type: 'soup_answer', answer: 'yes' });
    await a.c.waitFor(
      (m) => m.type === 'soup_state' && m.lastQuestion && m.lastQuestion.answer === 'yes',
      '回答广播（汤主）',
    );
    const ansGuess = await b.c.waitFor(
      (m) => m.type === 'soup_state' && m.lastQuestion && m.lastQuestion.answer === 'yes',
      '回答广播（猜题者）',
    );
    check(ansGuess.lastQuestion.answer === 'yes', '汤主的回答（是/否/无关/换个问法）同步给猜题者');

    // ================= 4. 海龟汤：揭晓 =================
    section('【4】海龟汤：揭晓后双方都能拿到汤底');

    a.c.send({ type: 'soup_reveal' });
    const rvHost = await a.c.waitFor(
      (m) => m.type === 'soup_state' && m.phase === 'revealed',
      '揭晓状态（汤主）',
    );
    const rvGuess = await b.c.waitFor(
      (m) => m.type === 'soup_state' && m.phase === 'revealed',
      '揭晓状态（猜题者）',
    );
    check(rvGuess.answer === answer, '揭晓后猜题者能拿到汤底，且与汤主看到的一致');
    check(rvHost.answer === answer, '揭晓后汤主仍能看到同一份汤底');
    check(
      b.c.rawTexts.some((t) => t.includes(answer)),
      '反向验证：揭晓后猜题者确实收到了汤底（证明前面「不含汤底」的检查不是空转）',
    );

    // ================= 5. 海龟汤：交换角色 =================
    section('【5】海龟汤：交换角色后可见性边界依然生效');

    b.c.send({ type: 'soup_swap' });
    const swNewHost = await b.c.waitFor(
      (m) => m.type === 'soup_state' && m.phase === 'playing',
      '交换角色后的状态（新汤主）',
    );
    const swOldHost = await a.c.waitFor(
      (m) => m.type === 'soup_state' && m.phase === 'playing',
      '交换角色后的状态（新猜题者）',
    );
    check(swNewHost.isHost === true && swOldHost.isHost === false, '交换后角色互换（原猜题者成为汤主）');
    check(
      typeof swNewHost.answer === 'string' && swNewHost.answer.length > 0,
      '新汤主收到新一题的汤底',
    );
    check(swOldHost.answer === null, '原汤主变成猜题者后，不再收到汤底');
    const newAnswer = swNewHost.answer;
    check(
      !a.c.rawTexts.some((t) => t.includes(newAnswer)),
      '原汤主（现猜题者）的全部原始消息中不含新汤底',
    );

    // ================= 6. HTTP 静态服务 =================
    section('【6】HTTP：静态资源与 /api/info');

    const home = await httpGet(port, '/');
    check(
      !!home && home.status === 200 && /text\/html/.test(String(home.headers['content-type'])),
      'GET / 返回 200 且 Content-Type 为 text/html',
    );
    check(!!home && home.body.includes('双人小游戏站'), '首页内容正常（含站点标题）');

    const css = await httpGet(port, '/style.css');
    check(
      !!css && css.status === 200 && /text\/css/.test(String(css.headers['content-type'])),
      'GET /style.css 返回 200 且 MIME 正确',
    );

    const js = await httpGet(port, '/app.js');
    check(
      !!js && js.status === 200 && /javascript/.test(String(js.headers['content-type'])),
      'GET /app.js 返回 200 且 MIME 正确',
    );

    const info = await httpGet(port, '/api/info');
    let infoJson = null;
    try { infoJson = JSON.parse(info.body); } catch (_) { /* ignore */ }
    check(!!infoJson && infoJson.ok === true && infoJson.soups > 0, '/api/info 可用且报告了题库数量');

    const miss = await httpGet(port, '/not-exist-file.txt');
    check(!!miss && miss.status === 404, '不存在的静态文件返回 404');

    const traversal = await httpGet(port, '/%2e%2e%2fpackage.json');
    check(
      !!traversal && (traversal.status === 403 || traversal.status === 404) &&
        !/game-hub/.test(traversal.body || ''),
      '目录穿越请求被拒绝（没有读到 public/ 之外的文件）',
    );

    // ================= 7. 红线自查（离线 / 依赖 / 题库格式） =================
    section('【7】红线自查：离线可用 + 只依赖 ws + 题库格式');

    const frontFiles = ['index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg']
      .map((name) => [name, fs.readFileSync(path.join(ROOT, 'public', name), 'utf8')]);
    const EXTERNAL_PATTERNS = [
      /<\s*(?:script|link|img|iframe|video|audio|source|embed|object)\b[^>]*\b(?:src|href)\s*=\s*["']?\s*https?:\/\//i,
      /url\(\s*["']?\s*https?:\/\//i,
      /@import\s+(?:url\()?\s*["']?\s*https?:\/\//i,
      /\bfetch\s*\(\s*["']https?:\/\//i,
    ];
    const offenders = [];
    for (const [name, text] of frontFiles) {
      for (const re of EXTERNAL_PATTERNS) {
        const hit = text.match(re);
        if (hit) offenders.push(`${name} → ${hit[0].trim()}`);
      }
    }
    check(
      offenders.length === 0,
      'public/ 下没有外部 CDN / 外链资源（w3.org 命名空间除外）',
      offenders.join('；'),
    );

    const cssText = frontFiles.find(([n]) => n === 'style.css')[1];
    check(!/@font-face/i.test(cssText), 'style.css 里没有 @font-face（只用系统字体栈，不引入网络字体）');

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    check(
      Object.keys(pkg.dependencies || {}).join(',') === 'ws',
      `运行时依赖只有 ws（当前：${Object.keys(pkg.dependencies || {}).join(', ') || '无'}）`,
    );
    check(
      !pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0,
      '没有 devDependencies（保持零构建步骤）',
    );

    const soups = JSON.parse(fs.readFileSync(path.join(ROOT, 'soups.json'), 'utf8'));
    check(
      Array.isArray(soups) && soups.length > 0 &&
        soups.every((s) =>
          s && typeof s.title === 'string' && s.title.length > 0 &&
          typeof s.surface === 'string' && s.surface.length > 0 &&
          typeof s.answer === 'string' && s.answer.length > 0 &&
          (s.hints === undefined || (Array.isArray(s.hints) && s.hints.every((h) => typeof h === 'string')))),
      `soups.json 每项都有 title / surface / answer（可选 hints 数组），共 ${Array.isArray(soups) ? soups.length : 0} 道`,
    );
  } finally {
    // 无论成功失败，都断开客户端并杀掉子进程
    for (const c of clients) c.destroy();
    await killServer(child);
    serverChild = null;
  }

  // ---------- 汇总 ----------
  const total = passed + failures.length;
  console.log(`\n${'─'.repeat(52)}`);
  if (failures.length === 0) {
    console.log(`✅ ${total} 项断言全部通过`);
  } else {
    console.log(`❌ ${failures.length}/${total} 项断言失败：`);
    for (const f of failures) console.log(`   - ${f}`);
    console.log('\n--- server.js 输出 ---');
    console.log(serverLog.trim() || '（无输出）');
  }
  return failures.length === 0 ? 0 : 1;
}

// ---------- 入口（带总超时兜底） ----------
const watchdog = setTimeout(() => {
  console.error(`\n❌ 测试整体超时（${TOTAL_MS}ms），强制退出。`);
  if (serverChild && serverChild.exitCode === null) {
    try { serverChild.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }
  process.exit(1);
}, TOTAL_MS);

main()
  .then((code) => {
    clearTimeout(watchdog);
    process.exit(code);
  })
  .catch((err) => {
    clearTimeout(watchdog);
    console.error(`\n💥 测试中断：${err && err.message ? err.message : err}`);
    console.error(`已统计：${passed} 项通过，${failures.length} 项失败`);
    if (serverLog.trim()) {
      console.error('--- server.js 输出 ---');
      console.error(serverLog.trim());
    }
    if (serverChild && serverChild.exitCode === null) {
      try { serverChild.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
    process.exit(1);
  });
