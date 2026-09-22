'use strict';

/**
 * game-hub 本地双人小游戏服务
 * - 原生 http 提供 public/ 静态文件
 * - ws 提供 WebSocket，处理房间 / 五子棋 / 海龟汤逻辑
 * - 监听 0.0.0.0，端口取 PORT，默认 3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- 海龟汤题库 ----------
let SOUPS = [];
try {
  SOUPS = JSON.parse(fs.readFileSync(path.join(__dirname, 'soups.json'), 'utf8'));
  if (!Array.isArray(SOUPS) || SOUPS.length === 0) throw new Error('empty');
} catch (err) {
  console.error('[game-hub] 无法加载 soups.json:', err.message);
  SOUPS = [{ title: '（题库缺失）', surface: '题库加载失败，请检查 soups.json。', answer: '无', hints: [] }];
}

// ---------- 内存房间 ----------
/** @type {Map<string, Room>} */
const rooms = new Map();
let nextPlayerId = 1;

/**
 * Room 结构:
 * {
 *   code, players: Map<playerId, {id, name, ws, alive}>,
 *   game: null | 'soup' | 'gomoku',
 *   gomoku: { board: Int8Array(225), turn: 1|2, colors: {playerId:1|2}, winner: null|1|2|'draw', winningLine: [[x,y]...]|null } | null,
 *   soup: { soupIndex, hostId, guesserId, phase: 'idle'|'playing'|'answering'|'guessing'|'revealed', log: [], lastQuestion, lastGuess } | null
 * }
 */

function genRoomCode() {
  for (let i = 0; i < 100; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  // 兜底：顺序查找
  for (let n = 1000; n <= 9999; n++) {
    const code = String(n);
    if (!rooms.has(code)) return code;
  }
  return null;
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) { /* ignore */ }
  }
}

function broadcast(room, obj, exceptId) {
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    safeSend(p.ws, obj);
  }
}

function roomPlayers(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name }));
}

function sendError(ws, message) {
  safeSend(ws, { type: 'error', message });
}

// ---------- 五子棋（服务端权威） ----------
const BOARD_SIZE = 15;
const EMPTY = 0;

function newGomoku(room) {
  // 先手在两人间随机
  const ids = [...room.players.keys()];
  const first = ids[Math.floor(Math.random() * ids.length)];
  const second = ids.find(id => id !== first);
  return {
    board: new Array(BOARD_SIZE * BOARD_SIZE).fill(EMPTY),
    turn: 1, // 1 = 黑先手
    colors: { [first]: 1, [second]: 2 }, // 1 黑 2 白
    winner: null, // 1 | 2 | 'draw'
    winningLine: null,
    moveCount: 0,
  };
}

function gomokuStateFor(room, viewerId) {
  const g = room.gomoku;
  const players = roomPlayers(room);
  const colorOf = g.colors || {};
  return {
    type: 'gomoku_state',
    board: g.board,
    size: BOARD_SIZE,
    turn: g.turn,
    winner: g.winner,
    winningLine: g.winningLine,
    moveCount: g.moveCount,
    players: players.map(p => ({ ...p, color: colorOf[p.id] || null })),
    youColor: colorOf[viewerId] || null,
  };
}

function checkWin(board, x, y, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    const line = [[x, y]];
    // 正方向
    for (let i = 1; i < 5; i++) {
      const nx = x + dx * i, ny = y + dy * i;
      if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) break;
      if (board[ny * BOARD_SIZE + nx] !== color) break;
      line.push([nx, ny]);
    }
    // 反方向
    for (let i = 1; i < 5; i++) {
      const nx = x - dx * i, ny = y - dy * i;
      if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) break;
      if (board[ny * BOARD_SIZE + nx] !== color) break;
      line.unshift([nx, ny]);
    }
    if (line.length >= 5) return line;
  }
  return null;
}

function handleGomokuMove(room, player, msg) {
  const g = room.gomoku;
  if (!g) return;
  if (g.winner) return sendError(player.ws, '本局已结束，请点击“再来一局”。');
  const color = g.colors[player.id];
  if (!color) return sendError(player.ws, '你不是本局玩家。');
  if (g.turn !== color) return sendError(player.ws, '还没轮到你落子。');
  const x = msg.x, y = msg.y;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) {
    return sendError(player.ws, '非法落子位置。');
  }
  const idx = y * BOARD_SIZE + x;
  if (g.board[idx] !== EMPTY) return sendError(player.ws, '这里已经有棋子了。');

  g.board[idx] = color;
  g.moveCount++;
  const line = checkWin(g.board, x, y, color);
  if (line) {
    g.winner = color;
    g.winningLine = line;
  } else if (g.moveCount >= BOARD_SIZE * BOARD_SIZE) {
    g.winner = 'draw';
  } else {
    g.turn = color === 1 ? 2 : 1;
  }
  for (const p of room.players.values()) {
    safeSend(p.ws, gomokuStateFor(room, p.id));
  }
}

// ---------- 海龟汤 ----------
function newSoup(room, hostId) {
  const ids = [...room.players.keys()];
  const guesserId = ids.find(id => id !== hostId) || null;
  let soupIndex = Math.floor(Math.random() * SOUPS.length);
  if (room.soup && SOUPS.length > 1) {
    // 尽量避免和上一题重复
    let guard = 0;
    while (soupIndex === room.soup.soupIndex && guard++ < 20) {
      soupIndex = Math.floor(Math.random() * SOUPS.length);
    }
  }
  return {
    soupIndex,
    hostId,
    guesserId,
    phase: 'playing', // playing -> revealed
    log: [{ kind: 'system', text: '新的一汤开始！汤面已公布，汤底只有汤主可见。', ts: Date.now() }],
    lastQuestion: null,
    lastGuess: null,
  };
}

function soupPublicState(room, viewerId) {
  const s = room.soup;
  if (!s) return null;
  const soup = SOUPS[s.soupIndex] || {};
  const isHost = viewerId === s.hostId;
  const players = roomPlayers(room);
  const hostName = (room.players.get(s.hostId) || {}).name || '汤主';
  const guesserName = (room.players.get(s.guesserId) || {}).name || '猜题者';
  const state = {
    type: 'soup_state',
    title: soup.title || '海龟汤',
    surface: soup.surface || '',
    // 默认不发提示，只有汤主/揭晓后才在下面按身份下发（与汤底同一道安全边界）
    hints: [],
    hostId: s.hostId,
    guesserId: s.guesserId,
    hostName,
    guesserName,
    isHost,
    phase: s.phase,
    log: s.log,
    players,
    lastQuestion: s.lastQuestion,
    lastGuess: s.lastGuess,
  };
  // 关键：汤底与提示只发给汤主，或揭晓后才发给所有人
  if (isHost || s.phase === 'revealed') {
    state.answer = soup.answer || '';
    state.hints = Array.isArray(soup.hints) ? soup.hints : [];
  } else {
    state.answer = null;
    state.hints = [];
  }
  return state;
}

function broadcastSoupState(room) {
  for (const p of room.players.values()) {
    safeSend(p.ws, soupPublicState(room, p.id));
  }
}

function soupLog(room, entry) {
  room.soup.log.push({ ts: Date.now(), ...entry });
  if (room.soup.log.length > 200) room.soup.log = room.soup.log.slice(-200);
}

// ---------- 房间通用状态 ----------
function roomUpdateFor(room, viewerId) {
  return {
    type: 'room_update',
    code: room.code,
    players: roomPlayers(room),
    game: room.game,
    you: viewerId,
  };
}

function broadcastRoomUpdate(room) {
  for (const p of room.players.values()) {
    safeSend(p.ws, roomUpdateFor(room, p.id));
  }
}

function broadcastGameState(room) {
  if (room.game === 'gomoku' && room.gomoku) {
    for (const p of room.players.values()) safeSend(p.ws, gomokuStateFor(room, p.id));
  } else if (room.game === 'soup' && room.soup) {
    broadcastSoupState(room);
  }
}

function getRoomOf(player) {
  if (!player.roomCode) return null;
  return rooms.get(player.roomCode) || null;
}

function leaveRoom(player, reason) {
  const room = getRoomOf(player);
  if (!room) { player.roomCode = null; return; }
  room.players.delete(player.id);
  player.roomCode = null;
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  const remaining = [...room.players.values()][0];
  safeSend(remaining.ws, { type: 'peer_left', message: reason || '对方离开了房间。' });
  // 游戏依赖两人：重置为大厅
  room.game = null;
  room.gomoku = null;
  room.soup = null;
  broadcastRoomUpdate(room);
}

// ---------- 消息处理 ----------
function handleMessage(ws, player, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    return sendError(ws, '消息格式错误。');
  }
  if (!msg || typeof msg.type !== 'string') return sendError(ws, '消息缺少 type。');

  switch (msg.type) {
    case 'create_room': {
      if (player.roomCode) leaveRoom(player);
      const code = genRoomCode();
      if (!code) return sendError(ws, '房间已满，请稍后再试。');
      const room = {
        code,
        players: new Map(),
        game: null,
        gomoku: null,
        soup: null,
        createdAt: Date.now(),
      };
      player.name = sanitizeName(msg.name) || `玩家${player.id}`;
      room.players.set(player.id, player);
      player.roomCode = code;
      rooms.set(code, room);
      safeSend(ws, roomUpdateFor(room, player.id));
      break;
    }

    case 'join_room': {
      const code = String(msg.code || '').trim();
      const room = rooms.get(code);
      if (!room) return sendError(ws, '房间不存在，请核对 4 位房间号。');
      if (room.players.size >= 2 && !room.players.has(player.id)) {
        return sendError(ws, '房间已满（最多 2 人）。');
      }
      if (player.roomCode && player.roomCode !== code) leaveRoom(player);
      player.name = sanitizeName(msg.name) || `玩家${player.id}`;
      room.players.set(player.id, player);
      player.roomCode = code;
      broadcastRoomUpdate(room);
      broadcastGameState(room);
      break;
    }

    case 'select_game': {
      const room = getRoomOf(player);
      if (!room) return sendError(ws, '请先创建或加入房间。');
      if (room.players.size < 2) return sendError(ws, '等待第二位玩家加入后才能开始游戏。');
      const game = msg.game;
      if (game !== 'soup' && game !== 'gomoku' && game !== null) {
        return sendError(ws, '未知游戏。');
      }
      room.game = game;
      if (game === 'gomoku') {
        room.soup = null;
        room.gomoku = newGomoku(room);
      } else if (game === 'soup') {
        room.gomoku = null;
        // 默认由发起者先当汤主
        room.soup = newSoup(room, player.id);
        soupLog(room, { kind: 'system', text: `${player.name} 选择了海龟汤，担任汤主。` });
      } else {
        room.gomoku = null;
        room.soup = null;
      }
      broadcastRoomUpdate(room);
      broadcastGameState(room);
      break;
    }

    case 'restart': {
      const room = getRoomOf(player);
      if (!room || !room.game) return sendError(ws, '当前没有进行中的游戏。');
      if (room.players.size < 2) return sendError(ws, '等待第二位玩家加入。');
      if (room.game === 'gomoku') {
        room.gomoku = newGomoku(room);
        broadcastGameState(room);
      } else if (room.game === 'soup') {
        room.soup = newSoup(room, room.soup ? room.soup.hostId : player.id);
        soupLog(room, { kind: 'system', text: '汤主重新抽了一道题。' });
        broadcastSoupState(room);
      }
      break;
    }

    // ---- 五子棋 ----
    case 'gomoku_move': {
      const room = getRoomOf(player);
      if (!room || room.game !== 'gomoku') return sendError(ws, '当前不在五子棋对局中。');
      handleGomokuMove(room, player, msg);
      break;
    }

    // ---- 海龟汤 ----
    case 'soup_start': {
      const room = getRoomOf(player);
      if (!room || room.game !== 'soup' || !room.soup) return sendError(ws, '当前不在海龟汤游戏中。');
      const s = room.soup;
      // 允许汤主换一题（仅自己能看到汤底时直接重抽）
      if (player.id !== s.hostId) return sendError(ws, '只有汤主可以换题。');
      let idx = Math.floor(Math.random() * SOUPS.length);
      let guard = 0;
      while (idx === s.soupIndex && SOUPS.length > 1 && guard++ < 20) {
        idx = Math.floor(Math.random() * SOUPS.length);
      }
      s.soupIndex = idx;
      s.phase = 'playing';
      s.log = [{ kind: 'system', text: '汤主换了一道题，汤面已更新。', ts: Date.now() }];
      s.lastQuestion = null;
      s.lastGuess = null;
      broadcastSoupState(room);
      break;
    }

    case 'soup_question': {
      const room = getRoomOf(player);
      if (!room || room.game !== 'soup' || !room.soup) return sendError(ws, '当前不在海龟汤游戏中。');
      const s = room.soup;
      if (s.phase !== 'playing') return sendError(ws, '本汤已揭晓，请开始新汤。');
      if (player.id !== s.guesserId) return sendError(ws, '只有猜题者可以提问。');
      const text = sanitizeText(msg.text, 200);
      if (!text) return sendError(ws, '问题不能为空。');
      s.lastQuestion = { id: s.log.length + 1, text, answer: null, by: player.name };
      soupLog(room, { kind: 'question', text, by: player.name, ref: s.lastQuestion.id });
      broadcastSoupState(room);
      break;
    }

    case 'soup_answer': {
      const room = getRoomOf(player);
      if (!room || room.game !== 'soup' || !room.soup) return sendError(ws, '当前不在海龟汤游戏中。');
      const s = room.soup;
      if (s.phase !== 'playing') return sendError(ws, '本汤已揭晓。');
      if (player.id !== s.hostId) return sendError(ws, '只有汤主可以回答。');
      const valid = ['yes', 'no', 'irrelevant', 'rephrase'];
      const answer = valid.includes(msg.answer) ? msg.answer : null;
      if (!answer) return sendError(ws, '非法回答。');
      if (!s.lastQuestion || s.lastQuestion.answer) return sendError(ws, '当前没有待回答的问题。');
      s.lastQuestion.answer = answer;
      const label = { yes: '是', no: '否', irrelevant: '无关', rephrase: '换个问法' }[answer];
      // 更新日志中对应的问题记录
      const entry = s.log.find(e => e.kind === 'question' && e.ref === s.lastQuestion.id);
      if (entry) entry.answer = answer;
      soupLog(room, { kind: 'answer', text: `汤主回答：${label}`, by: player.name, ref: s.lastQuestion.id });
      broadcastSoupState(room);
      break;
    }

    case 'soup_guess': {
      const room = getRoomOf(player);
      if (!room || room.game !== 'soup' || !room.soup) return sendError(ws, '当前不在海龟汤游戏中。');
      const s = room.soup;
      if (s.phase !== 'playing') return sendError(ws, '本汤已揭晓。');
      if (player.id !== s.guesserId) return sendError(ws, '只有猜题者可以提交最终猜测。');
      const text = sanitizeText(msg.text, 300);
      if (!text) return sendError(ws, '猜测内容不能为空。');
      s.lastGuess = { text, by: player.name, verdict: null };
      soupLog(room, { kind: 'guess', text, by: player.name });
      soupLog(room, { kind: 'system', text: '猜题者提交了最终推理，等待汤主判定。' });
      broadcastSoupState(room);
      break;
    }

    case 'soup_verdict': {
      const room = getRoomOf(player);
      if (!room || room.game !== 'soup' || !room.soup) return sendError(ws, '当前不在海龟汤游戏中。');
      const s = room.soup;
      if (player.id !== s.hostId) return sendError(ws, '只有汤主可以判定。');
      if (!s.lastGuess || s.lastGuess.verdict) return sendError(ws, '当前没有待判定的猜测。');
      const pass = msg.pass === true;
      s.lastGuess.verdict = pass ? 'pass' : 'fail';
      const g = s.log.find(e => e.kind === 'guess' && e.text === s.lastGuess.text && !e.verdict);
      if (g) g.verdict = s.lastGuess.verdict;
      if (pass) {
        s.phase = 'revealed';
        soupLog(room, { kind: 'system', text: '汤主判定推理正确！汤底揭晓。' });
      } else {
        soupLog(room, { kind: 'system', text: '汤主判定推理不对，继续加油猜！' });
      }
      broadcastSoupState(room);
      break;
    }

    case 'soup_reveal': {
      const room = getRoomOf(player);
      if (!room || room.game !== 'soup' || !room.soup) return sendError(ws, '当前不在海龟汤游戏中。');
      const s = room.soup;
      const isHost = player.id === s.hostId;
      const isGuesser = player.id === s.guesserId;
      if (!isHost && !isGuesser) return sendError(ws, '只有对局双方可以操作。');
      if (s.phase === 'revealed') return;
      s.phase = 'revealed';
      soupLog(room, { kind: 'system', text: isHost ? '汤主揭晓了汤底。' : '猜题者放弃了，汤底揭晓。' });
      broadcastSoupState(room);
      break;
    }

    case 'soup_swap': {
      const room = getRoomOf(player);
      if (!room || room.game !== 'soup' || !room.soup) return sendError(ws, '当前不在海龟汤游戏中。');
      if (room.players.size < 2) return sendError(ws, '需要两名玩家。');
      const s = room.soup;
      const newHost = s.guesserId || [...room.players.keys()].find(id => id !== s.hostId);
      if (!newHost) return sendError(ws, '无法交换角色。');
      room.soup = newSoup(room, newHost);
      soupLog(room, { kind: 'system', text: '角色已交换，新汤开始！' });
      broadcastRoomUpdate(room);
      broadcastSoupState(room);
      break;
    }

    case 'leave_room': {
      leaveRoom(player, '对方主动离开了房间。');
      break;
    }

    case 'ping': {
      safeSend(ws, { type: 'pong', t: Date.now() });
      break;
    }

    default:
      sendError(ws, `未知消息类型：${msg.type}`);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f<>`]/g;

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(CONTROL_CHARS, '').trim().slice(0, 16);
}

function sanitizeText(text, max) {
  if (typeof text !== 'string') return '';
  return text.replace(CONTROL_CHARS, '').trim().slice(0, max);
}

// ---------- HTTP 静态服务 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, soups: SOUPS.length, lan: lanAddresses() }));
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const player = { id: nextPlayerId++, name: '', ws, roomCode: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  safeSend(ws, { type: 'welcome', playerId: player.id });

  ws.on('message', (data) => {
    if (data.length > 8 * 1024) return sendError(ws, '消息过大。');
    handleMessage(ws, player, data.toString());
  });

  ws.on('close', () => {
    leaveRoom(player, '对方断开了连接。');
  });

  ws.on('error', () => { /* ignore */ });
});

// 心跳，清理死连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* ignore */ }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`[game-hub] 双人小游戏站已启动`);
  console.log(`  本机访问:   http://localhost:${PORT}`);
  const lan = lanAddresses();
  if (lan.length) {
    for (const it of lan) {
      console.log(`  局域网访问: http://${it.address}:${PORT}  (${it.name})`);
    }
  } else {
    console.log('  局域网访问: 未检测到非回环 IPv4 地址');
  }
  console.log('  手机请连接同一 Wi-Fi 后访问上方局域网地址。');
});
