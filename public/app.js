'use strict';

/* 双人小游戏站前端（原生 JS，无构建） */
(function () {
  // ---------- 工具 ----------
  const $ = (id) => document.getElementById(id);
  const PAGES = ['lobby', 'room', 'gomoku', 'soup'];
  let visiblePage = null;

  function showPage(name) {
    const changed = visiblePage !== name;
    for (const p of PAGES) $(p).classList.toggle('hidden', p !== name);
    visiblePage = name;
    if (changed) window.scrollTo(0, 0);
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- 状态 ----------
  const state = {
    ws: null,
    playerId: null,
    roomCode: localStorage.getItem('gh_room') || '',
    resumeToken: localStorage.getItem('gh_resume') || '',
    name: localStorage.getItem('gh_name') || '',
    players: [],
    game: null,
    gomoku: null, // {board, size, turn, winner, winningLine, youColor, players}
    soup: null,
    answerVisible: false,
    reconnectTimer: null,
    reconnectDelay: 1000,
    connectTimer: null,
    restoreTimer: null,
    socketAbortTimer: null,
    heartbeatTimer: null,
    lastPongAt: 0,
    connectionState: 'idle', // connecting | restoring | ready | failed
    latestSessionToken: '',
    offlineUntil: null,
    offlineTimer: null,
    sessionReplaced: false,
  };

  $('nameInput').value = state.name;
  if (state.roomCode) $('joinCodeInput').value = state.roomCode;

  // ---------- WebSocket ----------
  function setConnBar(text, visible = true) {
    const el = $('connBar');
    el.textContent = text;
    el.classList.toggle('hidden', !visible);
  }

  function remainingText(until) {
    if (!until) return '';
    const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    return seconds > 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`;
  }

  function renderConnectionNotice() {
    clearTimeout(state.offlineTimer);
    if (state.offlineUntil && state.offlineUntil > Date.now()) {
      setConnBar(`对方暂时离线，当前对局保留 ${remainingText(state.offlineUntil)}，正在等待恢复…`);
      updateActionAvailability();
      state.offlineTimer = setTimeout(renderConnectionNotice, 1000);
      return;
    }
    if (state.offlineUntil) {
      state.offlineUntil = null;
      setConnBar('恢复期限已到，请重新创建或加入房间。');
      updateActionAvailability();
      return;
    }
    if (state.connectionState === 'connecting') setConnBar('正在连接…');
    else if (state.connectionState === 'restoring') setConnBar('正在恢复房间和对局…');
    else if (state.connectionState === 'failed') setConnBar('恢复失败，请重新创建或加入房间。');
    else if (state.connectionState === 'ready') setConnBar('', false);
    updateActionAvailability();
  }

  const GAME_ACTIONS = new Set([
    'select_game', 'restart', 'gomoku_move', 'soup_start', 'soup_question',
    'soup_answer', 'soup_guess', 'soup_verdict', 'soup_reveal', 'soup_swap',
  ]);

  function canUseTransport() {
    return !!state.ws && state.ws.readyState === WebSocket.OPEN &&
      !state.sessionReplaced && state.connectionState !== 'connecting' && state.connectionState !== 'restoring';
  }

  function canUseGameActions() {
    return canUseTransport() && state.connectionState === 'ready' && !state.offlineUntil;
  }

  function updateActionAvailability() {
    const connected = canUseTransport();
    const roomReady = canUseGameActions();
    $('createBtn').disabled = !connected;
    $('joinBtn').disabled = !connected;
    $('pickSoup').disabled = !roomReady || state.players.length < 2;
    $('pickGomoku').disabled = !roomReady || state.players.length < 2;
    $('leaveRoomBtn').disabled = !connected;
  }

  function stopHeartbeat() {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  function clearRestoreTimer() {
    clearTimeout(state.restoreTimer);
    state.restoreTimer = null;
  }

  function startRestoreTimer(ws) {
    clearRestoreTimer();
    state.restoreTimer = setTimeout(() => {
      if (state.ws !== ws || state.connectionState !== 'restoring') return;
      // 网络慢只代表本次恢复请求超时，不能把仍可能有效的房间凭证当成失效凭证删除。
      state.offlineUntil = null;
      state.connectionState = 'failed';
      renderConnectionNotice();
      showPage('lobby');
      toast('房间恢复超时，请重新创建或加入房间。');
    }, 8000);
  }

  function abandonUnresponsiveSocket(ws) {
    if (state.ws !== ws) return;
    clearTimeout(state.socketAbortTimer);
    state.socketAbortTimer = setTimeout(() => {
      if (state.ws !== ws) return;
      state.ws = null;
      stopHeartbeat();
      state.connectionState = 'connecting';
      setConnBar(state.roomCode ? '连接无响应，正在恢复房间…' : '连接无响应，正在重连…');
      scheduleReconnect();
    }, 2000);
    try { ws.close(4001, 'heartbeat timeout'); } catch (_) { /* ignore */ }
  }

  function startHeartbeat(ws) {
    stopHeartbeat();
    state.lastPongAt = Date.now();
    state.heartbeatTimer = setInterval(() => {
      if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - state.lastPongAt > 32000) {
        abandonUnresponsiveSocket(ws);
        return;
      }
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) { /* onclose 会处理 */ }
    }, 15000);
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    if (state.sessionReplaced) return;
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    state.connectionState = state.roomCode ? 'restoring' : 'connecting';
    renderConnectionNotice();
    const ws = new WebSocket(wsUrl());
    state.ws = ws;
    state.connectTimer = setTimeout(() => {
      if (state.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(4000, 'connect timeout'); } catch (_) { /* ignore */ }
      }
    }, 8000);

    ws.onopen = () => {
      if (state.ws !== ws) return;
      clearTimeout(state.connectTimer);
      state.connectTimer = null;
      state.reconnectDelay = 1000;
      state.connectionState = state.roomCode ? 'restoring' : 'ready';
      renderConnectionNotice();
      startHeartbeat(ws);
      // 只有收到 room_update / 游戏状态后，才会被视为已恢复。
      if (state.roomCode) {
        startRestoreTimer(ws);
        sendOnSocket(ws, {
          type: 'join_room',
          code: state.roomCode,
          name: state.name,
          ...(state.resumeToken ? { resumeToken: state.resumeToken } : {}),
        });
      }
    };

    ws.onmessage = (ev) => {
      if (state.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleServer(msg);
    };

    ws.onclose = (event) => {
      if (state.ws !== ws) return;
      clearTimeout(state.connectTimer);
      state.connectTimer = null;
      clearTimeout(state.socketAbortTimer);
      state.socketAbortTimer = null;
      state.ws = null;
      stopHeartbeat();
      clearRestoreTimer();
      if (state.sessionReplaced || event.code === 4002) {
        state.connectionState = 'failed';
        setConnBar('此标签页已被另一连接接管，请刷新页面后恢复。');
        updateActionAvailability();
        return;
      }
      state.connectionState = 'connecting';
      setConnBar(state.roomCode ? '连接已断开，正在恢复房间…' : '连接已断开，正在重连…');
      scheduleReconnect();
    };

    ws.onerror = () => { /* onclose 会跟进 */ };
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    const jitter = Math.floor(Math.random() * 500);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
      connect();
    }, state.reconnectDelay + jitter);
  }

  function sendOnSocket(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); return true; } catch (_) { /* onclose 会处理 */ }
    }
    return false;
  }

  function send(obj) {
    if (obj.type !== 'ping' && !canUseTransport()) {
      toast(state.sessionReplaced ? '当前标签页已被另一连接接管，请刷新页面。' : '正在恢复连接，请稍候…');
      return false;
    }
    if (GAME_ACTIONS.has(obj.type) && !canUseGameActions()) {
      toast('当前对局未同步完成，暂时不能操作。');
      return false;
    }
    if (sendOnSocket(state.ws, obj)) {
      return true;
    }
    toast('连接已断开，正在重连…');
    connect();
    return false;
  }

  // ---------- 服务端消息 ----------
  function handleServer(msg) {
    switch (msg.type) {
      case 'welcome':
        state.playerId = msg.playerId;
        state.latestSessionToken = msg.sessionToken || '';
        state.sessionReplaced = false;
        // 大厅没有待恢复的房间时，必须换成当前连接的新凭证；房间恢复期间保留旧凭证，等待服务端确认。
        if ((!state.roomCode || !state.resumeToken) && msg.sessionToken) {
          state.resumeToken = msg.sessionToken;
          localStorage.setItem('gh_resume', msg.sessionToken);
        }
        break;
      case 'session_replaced':
        state.sessionReplaced = true;
        state.connectionState = 'failed';
        setConnBar('此标签页已被另一连接接管，请刷新页面后恢复。');
        toast(msg.message || '此标签页已被另一连接接管');
        updateActionAvailability();
        break;
      case 'error':
        if ((msg.code === 'resume_invalid' || msg.code === 'room_not_found') && state.roomCode) {
          clearRestoreTimer();
          state.resumeToken = state.latestSessionToken;
          state.roomCode = '';
          state.game = null;
          state.gomoku = null;
          state.soup = null;
          if (state.resumeToken) localStorage.setItem('gh_resume', state.resumeToken);
          else localStorage.removeItem('gh_resume');
          localStorage.removeItem('gh_room');
          state.connectionState = 'failed';
          renderConnectionNotice();
          showPage('lobby');
        }
        if (!$('lobby').classList.contains('hidden')) {
          $('lobbyError').textContent = msg.message || '出错了';
        } else {
          toast(msg.message || '出错了');
        }
        break;
      case 'room_update':
        clearRestoreTimer();
        if (msg.resumeToken) {
          state.resumeToken = msg.resumeToken;
          state.latestSessionToken = msg.resumeToken;
          localStorage.setItem('gh_resume', msg.resumeToken);
        }
        onRoomUpdate(msg);
        break;
      case 'peer_left':
        if (msg.temporary) {
          state.offlineUntil = msg.reconnectUntil || null;
          renderConnectionNotice();
          toast(msg.message || '对方暂时断开，正在等待恢复');
        } else {
          state.offlineUntil = null;
          state.game = null;
          state.gomoku = null;
          state.soup = null;
          state.connectionState = 'ready';
          renderConnectionNotice();
          showPage('room');
          toast(msg.message || '对方离开了房间');
        }
        break;
      case 'room_left':
        break;
      case 'pong':
        state.lastPongAt = Date.now();
        break;
      case 'gomoku_state':
        clearRestoreTimer();
        state.gomoku = msg;
        state.game = 'gomoku';
        showPage('gomoku');
        // 必须先显示页面再测量 canvas；隐藏元素的 clientWidth 为 0，
        // 否则刷新恢复时会按兜底尺寸绘制，之后点击坐标会整体偏移。
        renderGomoku();
        break;
      case 'soup_state':
        clearRestoreTimer();
        state.soup = msg;
        state.game = 'soup';
        renderSoup();
        showPage('soup');
        break;
      default:
        break;
    }
  }

  function onRoomUpdate(msg) {
    state.connectionState = 'ready';
    state.playerId = msg.you || state.playerId;
    state.roomCode = msg.code;
    state.players = msg.players;
    state.game = msg.game;
    localStorage.setItem('gh_room', msg.code);
    state.offlineUntil = msg.paused ? msg.resumeUntil : null;
    renderConnectionNotice();

    $('roomCode').textContent = msg.code;
    renderPlayerList(msg.players);

    const full = msg.players.length >= 2;
    $('waitTip').classList.toggle('hidden', full);
    $('pickSoup').disabled = !full;
    $('pickGomoku').disabled = !full;

    // 若服务端告诉我们当前在游戏里，等待对应的 state 消息切页
    if (!msg.game) {
      showPage('room');
    }
  }

  function renderPlayerList(players) {
    const box = $('playerList');
    box.innerHTML = '';
    for (const p of players) {
      const chip = document.createElement('span');
      chip.className = 'player-chip' + (p.id === state.playerId ? ' me' : '');
      chip.textContent = (p.id === state.playerId ? '我 · ' : '') + (p.name || `玩家${p.id}`) + (p.online === false ? '（离线）' : '');
      box.appendChild(chip);
    }
  }

  // ---------- 大厅 ----------
  $('createBtn').addEventListener('click', () => {
    $('lobbyError').textContent = '';
    state.name = $('nameInput').value.trim();
    localStorage.setItem('gh_name', state.name);
    send({ type: 'create_room', name: state.name });
  });

  $('joinBtn').addEventListener('click', () => {
    $('lobbyError').textContent = '';
    const code = $('joinCodeInput').value.trim();
    if (!/^\d{4}$/.test(code)) {
      $('lobbyError').textContent = '请输入 4 位数字房间号';
      return;
    }
    state.name = $('nameInput').value.trim();
    localStorage.setItem('gh_name', state.name);
    send({ type: 'join_room', code, name: state.name });
  });

  $('joinCodeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  // ---------- 房间 ----------
  $('copyCodeBtn').addEventListener('click', async () => {
    const code = state.roomCode;
    try {
      await navigator.clipboard.writeText(code);
      toast('房间号已复制：' + code);
    } catch (_) {
      // 回退
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('房间号已复制：' + code); }
      catch (e) { toast('复制失败，请手动记下：' + code); }
      ta.remove();
    }
  });

  $('pickSoup').addEventListener('click', () => send({ type: 'select_game', game: 'soup' }));
  $('pickGomoku').addEventListener('click', () => send({ type: 'select_game', game: 'gomoku' }));

  $('leaveRoomBtn').addEventListener('click', () => {
    send({ type: 'leave_room' });
    state.roomCode = '';
    // 主动离开只清房间，不清当前连接仍有效的会话凭证；同一 socket 随后创建新房间时会继续使用它。
    state.resumeToken = state.latestSessionToken || state.resumeToken;
    state.offlineUntil = null;
    localStorage.removeItem('gh_room');
    if (state.resumeToken) localStorage.setItem('gh_resume', state.resumeToken);
    else localStorage.removeItem('gh_resume');
    state.gomoku = null;
    state.soup = null;
    showPage('lobby');
  });

  // ---------- 五子棋 ----------
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  let boardMetrics = { pad: 0, cell: 0, size: 15, px: 0 };

  function setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    // clientWidth/clientHeight 已经排除 canvas border，正好对应绘图内容区。
    const cssSize = Math.min(canvas.clientWidth, canvas.clientHeight);
    if (!Number.isFinite(cssSize) || cssSize <= 0) return false;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = cssSize * 0.05;
    boardMetrics = {
      px: cssSize,
      pad,
      cell: (cssSize - pad * 2) / 14,
      size: 15,
    };
    return true;
  }

  function drawBoard() {
    if (!state.gomoku) return;
    if (!setupCanvas()) return;
    const { pad, cell, px } = boardMetrics;
    const g = state.gomoku;

    // 方格纸底色
    ctx.fillStyle = '#f8f2e3';
    ctx.fillRect(0, 0, px, px);

    // 铅笔网格线
    ctx.strokeStyle = 'rgba(61,61,61,0.5)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 15; i++) {
      const p = pad + i * cell;
      ctx.beginPath(); ctx.moveTo(pad, p); ctx.lineTo(px - pad, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, pad); ctx.lineTo(p, px - pad); ctx.stroke();
    }
    // 星位
    const stars = [3, 7, 11];
    ctx.fillStyle = 'rgba(61,61,61,0.6)';
    for (const sx of stars) for (const sy of stars) {
      ctx.beginPath();
      ctx.arc(pad + sx * cell, pad + sy * cell, Math.max(2, cell * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }

    // 棋子
    for (let y = 0; y < 15; y++) {
      for (let x = 0; x < 15; x++) {
        const v = g.board[y * 15 + x];
        if (!v) continue;
        drawStone(x, y, v === 1 ? '#2b2b29' : '#fffcf3');
      }
    }

    // 最后一手标记：小红圈
    let lx = -1, ly = -1;
    outer:
    for (let y = 14; y >= 0; y--) {
      for (let x = 14; x >= 0; x--) {
        if (g.board[y * 15 + x]) { lx = x; ly = y; break outer; }
      }
    }
    if (lx >= 0) {
      ctx.beginPath();
      ctx.arc(pad + lx * cell, pad + ly * cell, cell * 0.48, 0, Math.PI * 2);
      ctx.strokeStyle = '#e0604f';
      ctx.lineWidth = Math.max(1.5, cell * 0.08);
      ctx.stroke();
    }

    // 胜利连线：红色蜡笔粗线
    if (g.winningLine && g.winningLine.length) {
      ctx.strokeStyle = '#e0604f';
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(3, cell * 0.14);
      const first = g.winningLine[0];
      const last = g.winningLine[g.winningLine.length - 1];
      ctx.beginPath();
      ctx.moveTo(pad + first[0] * cell, pad + first[1] * cell);
      ctx.lineTo(pad + last[0] * cell, pad + last[1] * cell);
      ctx.stroke();
    }
  }

  function drawStone(x, y, color) {
    const { pad, cell } = boardMetrics;
    const cx = pad + x * cell, cy = pad + y * cell;
    const r = cell * 0.42;
    // 手绘感：两层略微错开的圆
    ctx.beginPath();
    ctx.arc(cx + cell * 0.02, cy + cell * 0.02, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = color === '#2b2b29' ? '#161513' : '#3d3d3d';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 白子高光
    if (color !== '#2b2b29') {
      ctx.beginPath();
      ctx.arc(cx - r * 0.3, cy - r * 0.32, r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(61,61,61,0.15)';
      ctx.fill();
    }
  }

  function boardPosFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const clientX = ev.clientX !== undefined ? ev.clientX : (ev.touches && ev.touches[0].clientX);
    const clientY = ev.clientY !== undefined ? ev.clientY : (ev.touches && ev.touches[0].clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !boardMetrics.px) return null;

    // board-wrap 有轻微旋转，getBoundingClientRect() 是旋转后的包围盒，
    // 直接减 rect.left/top 会把角点映射到错误的格子。先把屏幕坐标
    // 逆变换回 canvas 未旋转的布局坐标，再扣除 canvas 边框。
    let a = 1, b = 0, c = 0, d = 1;
    let transformEl = canvas;
    while (transformEl && transformEl !== document.body) {
      const transform = getComputedStyle(transformEl).transform;
      if (transform && transform !== 'none') {
        const values = transform.match(/^matrix\(([^)]+)\)$/);
        const values3d = transform.match(/^matrix3d\(([^)]+)\)$/);
        if (values) {
          const m = values[1].split(',').map(Number);
          [a, b, c, d] = [m[0], m[1], m[2], m[3]];
        } else if (values3d) {
          const m = values3d[1].split(',').map(Number);
          [a, b, c, d] = [m[0], m[1], m[4], m[5]];
        }
        break;
      }
      transformEl = transformEl.parentElement;
    }

    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-6) return null;
    const outerWidth = canvas.offsetWidth || canvas.clientWidth;
    const outerHeight = canvas.offsetHeight || canvas.clientHeight;
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const localX = (d * dx - c * dy) / determinant + outerWidth / 2;
    const localY = (-b * dx + a * dy) / determinant + outerHeight / 2;
    const borderLeft = parseFloat(getComputedStyle(canvas).borderLeftWidth) || 0;
    const borderTop = parseFloat(getComputedStyle(canvas).borderTopWidth) || 0;
    const px = localX - borderLeft;
    const py = localY - borderTop;
    const { pad, cell } = boardMetrics;
    const x = Math.round((px - pad) / cell);
    const y = Math.round((py - pad) / cell);
    if (x < 0 || y < 0 || x > 14 || y > 14) return null;
    return { x, y };
  }

  const BOARD_TAP_SLOP = 8;
  let boardGesture = null;

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.isPrimary === false) {
      if (boardGesture) boardGesture.multi = true;
      return;
    }
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (boardGesture) {
      boardGesture.multi = true;
      return;
    }
    boardGesture = {
      pointerId: ev.pointerId,
      pointerType: ev.pointerType,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: false,
      multi: false,
    };
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!boardGesture || ev.pointerId !== boardGesture.pointerId) return;
    const dx = ev.clientX - boardGesture.startX;
    const dy = ev.clientY - boardGesture.startY;
    const slop = boardGesture.pointerType === 'mouse' ? 4 : BOARD_TAP_SLOP;
    if (Math.hypot(dx, dy) > slop) boardGesture.moved = true;
  });

  canvas.addEventListener('pointerup', (ev) => {
    if (!boardGesture || ev.pointerId !== boardGesture.pointerId) return;
    const gesture = boardGesture;
    boardGesture = null;
    const dx = ev.clientX - gesture.startX;
    const dy = ev.clientY - gesture.startY;
    const slop = gesture.pointerType === 'mouse' ? 4 : BOARD_TAP_SLOP;
    if (gesture.moved || gesture.multi || ev.isPrimary === false || Math.hypot(dx, dy) > slop) return;
    if (!state.gomoku || state.gomoku.winner || !canUseGameActions()) return;
    const pos = boardPosFromEvent(ev);
    if (!pos) return;
    ev.preventDefault();
    send({ type: 'gomoku_move', x: pos.x, y: pos.y });
  });

  canvas.addEventListener('pointercancel', (ev) => {
    if (boardGesture && ev.pointerId === boardGesture.pointerId) boardGesture = null;
  });

  // 鼠标按住棋盘拖出后在外部松开时，棋盘不会收到 pointerup；窗口级
  // 清理避免下一次点击被错误当成多指/残留手势。
  window.addEventListener('pointerup', (ev) => {
    if (boardGesture && ev.pointerId === boardGesture.pointerId) boardGesture = null;
  });
  window.addEventListener('pointercancel', (ev) => {
    if (boardGesture && ev.pointerId === boardGesture.pointerId) boardGesture = null;
  });

  function renderGomoku() {
    const g = state.gomoku;
    if (!g) return;
    const statusEl = $('gomokuStatus');
    const playersEl = $('gomokuPlayers');

    const nameOf = (color) => {
      const p = (g.players || []).find((pl) => pl.color === color);
      return p ? p.name : (color === 1 ? '黑方' : '白方');
    };

    if (g.paused) {
      statusEl.textContent = `对方暂时离线，当前对局已暂停（保留 ${remainingText(g.resumeUntil)}）`;
    } else if (g.winner === 'draw') {
      statusEl.innerHTML = '<span class="win">平局！棋盘已满</span>';
    } else if (g.winner) {
      const winName = nameOf(g.winner);
      const mine = g.youColor === g.winner;
      statusEl.innerHTML = `<span class="win">${mine ? '🎉 你赢了！' : escapeHtml(winName) + ' 获胜'}（${g.winner === 1 ? '黑' : '白'}方五连）</span>`;
    } else {
      const turnName = nameOf(g.turn);
      const mine = g.youColor === g.turn;
      statusEl.textContent = mine ? '轮到你了，请落子' : `等待 ${turnName} 落子…`;
    }

    playersEl.innerHTML = '';
    for (const p of (g.players || [])) {
      const span = document.createElement('span');
      const dot = `<span class="stone-dot ${p.color === 1 ? 'stone-black' : 'stone-white'}"></span>`;
      const me = p.id === state.playerId ? '（我）' : '';
      const offline = p.online === false ? ' <span class="muted">（离线）</span>' : '';
      const turnFlag = (!g.paused && !g.winner && g.turn === p.color) ? ' <span class="turn-flag">● 行棋中</span>' : '';
      span.innerHTML = `${dot}${escapeHtml(p.name)}${me}${offline}${turnFlag}`;
      playersEl.appendChild(span);
    }

    drawBoard();
    $('gomokuRestart').disabled = !!g.paused || !canUseGameActions();
  }

  $('gomokuRestart').addEventListener('click', () => send({ type: 'restart' }));
  $('gomokuBack').addEventListener('click', () => {
    send({ type: 'select_game', game: null });
    showPage('room');
  });

  window.addEventListener('resize', () => {
    if (!$('gomoku').classList.contains('hidden')) drawBoard();
  });

  // ---------- 海龟汤 ----------
  const ANSWER_LABEL = { yes: '是', no: '否', irrelevant: '无关', rephrase: '换个问法' };

  function renderSoup() {
    const s = state.soup;
    if (!s) return;
    const paused = !!s.paused;

    $('soupTitle').textContent = s.title || '海龟汤';
    $('soupSurface').textContent = s.surface || '';

    const roleEl = $('soupRole');
    roleEl.textContent = s.isHost ? '我是汤主' : '我是猜题者';
    roleEl.classList.toggle('guesser', !s.isHost);

    // 提示：只有汤主可见（猜题者看到提示会泄底）
    const hintsEl = $('soupHints');
    if (s.isHost && s.hints && s.hints.length) {
      hintsEl.innerHTML = '<strong>给汤主的提示：</strong><ul>' +
        s.hints.map((h) => `<li>${escapeHtml(h)}</li>`).join('') + '</ul>';
      hintsEl.classList.remove('hidden');
    } else {
      hintsEl.classList.add('hidden');
      hintsEl.innerHTML = '';
    }

    const revealed = s.phase === 'revealed';
    $('hostPanel').classList.toggle('hidden', !s.isHost || revealed);
    $('guesserPanel').classList.toggle('hidden', s.isHost || revealed);
    $('revealedPanel').classList.toggle('hidden', !revealed);
    if (revealed) $('revealedAnswer').textContent = s.answer || '';

    // 汤主底牌
    if (s.isHost) {
      $('answerBox').textContent = s.answer || '';
      $('answerBox').classList.toggle('hidden', !state.answerVisible);
      $('answerToggle').textContent = state.answerVisible ? '🙈 收起汤底' : '👁 查看汤底（仅你可见）';

      // 待回答问题
      const pendingQ = s.lastQuestion && !s.lastQuestion.answer;
      $('hostPending').textContent = paused
        ? `对方暂时离线，当前汤暂停（保留 ${remainingText(s.resumeUntil)}）`
        : pendingQ
        ? `猜题者问：「${s.lastQuestion.text}」—— 请回答：`
        : (s.phase === 'playing' ? '等待猜题者提问…' : '');
      document.querySelectorAll('.btn-answer').forEach((b) => { b.disabled = paused || !pendingQ; });

      // 待判定最终推理
      const pendingGuess = s.lastGuess && !s.lastGuess.verdict;
      $('verdictBox').classList.toggle('hidden', !pendingGuess);
    }

    ['hostReveal', 'hostNewSoup', 'verdictPass', 'verdictFail', 'askBtn', 'finalGuessBtn', 'giveUpBtn', 'swapBtn']
      .forEach((id) => { if ($(id)) $(id).disabled = paused || !canUseGameActions(); });
    $('questionInput').disabled = paused;

    renderChat(s.log || []);
  }

  function renderChat(log) {
    const box = $('chatLog');
    box.innerHTML = '';
    for (const entry of log) {
      const div = document.createElement('div');
      if (entry.kind === 'question') {
        div.className = 'bubble question';
        const ans = entry.answer ? ` <span class="tag">→ ${ANSWER_LABEL[entry.answer]}</span>` : '';
        div.innerHTML = `<span class="who">${escapeHtml(entry.by || '猜题者')} 提问</span>${escapeHtml(entry.text)}${ans}`;
      } else if (entry.kind === 'answer') {
        div.className = 'bubble answer';
        div.innerHTML = `<span class="who">${escapeHtml(entry.by || '汤主')}</span>${escapeHtml(entry.text)}`;
      } else if (entry.kind === 'guess') {
        div.className = 'bubble guess';
        const verdict = entry.verdict === 'pass' ? '（✅ 判定正确）' : entry.verdict === 'fail' ? '（❌ 未通过）' : '（等待判定）';
        div.innerHTML = `<span class="who">${escapeHtml(entry.by || '猜题者')} 最终推理</span>${escapeHtml(entry.text)} <span class="tag">${verdict}</span>`;
      } else {
        div.className = 'bubble system';
        div.textContent = entry.text;
      }
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  }

  // 汤主：查看/收起汤底
  $('answerToggle').addEventListener('click', () => {
    state.answerVisible = !state.answerVisible;
    renderSoup();
  });

  // 汤主：快捷回答
  document.querySelectorAll('.btn-answer').forEach((btn) => {
    btn.addEventListener('click', () => {
      send({ type: 'soup_answer', answer: btn.dataset.answer });
    });
  });

  // 汤主：判定最终推理
  $('verdictPass').addEventListener('click', () => send({ type: 'soup_verdict', pass: true }));
  $('verdictFail').addEventListener('click', () => send({ type: 'soup_verdict', pass: false }));

  // 汤主：揭晓 / 换题
  $('hostReveal').addEventListener('click', () => send({ type: 'soup_reveal' }));
  $('hostNewSoup').addEventListener('click', () => send({ type: 'soup_start' }));

  // 猜题者：提问
  function askQuestion() {
    const input = $('questionInput');
    const text = input.value.trim();
    if (!text) return toast('请输入问题');
    if (send({ type: 'soup_question', text })) input.value = '';
  }
  $('askBtn').addEventListener('click', askQuestion);
  $('questionInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); askQuestion(); }
  });

  // 猜题者：最终推理弹窗
  $('finalGuessBtn').addEventListener('click', () => {
    if (!canUseGameActions()) return toast('当前对局未同步完成，暂时不能操作。');
    $('guessText').value = '';
    $('guessModal').classList.remove('hidden');
    setTimeout(() => $('guessText').focus(), 50);
  });
  $('guessCancel').addEventListener('click', () => $('guessModal').classList.add('hidden'));
  $('guessSubmit').addEventListener('click', () => {
    const text = $('guessText').value.trim();
    if (!text) return toast('请输入推理内容');
    if (send({ type: 'soup_guess', text })) $('guessModal').classList.add('hidden');
  });

  // 猜题者：放弃
  $('giveUpBtn').addEventListener('click', () => send({ type: 'soup_reveal' }));

  // 揭晓后：交换角色 / 返回
  $('swapBtn').addEventListener('click', () => {
    state.answerVisible = false;
    send({ type: 'soup_swap' });
  });
  $('soupBack').addEventListener('click', () => {
    send({ type: 'select_game', game: null });
    showPage('room');
  });
  $('soupBack2').addEventListener('click', () => {
    send({ type: 'select_game', game: null });
    showPage('room');
  });

  function syncRoom() {
    if (state.sessionReplaced) return;
    if (!state.roomCode) {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connect();
      return;
    }
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.connectionState = 'restoring';
      renderConnectionNotice();
      sendOnSocket(state.ws, {
        type: 'join_room',
        code: state.roomCode,
        name: state.name,
        ...(state.resumeToken ? { resumeToken: state.resumeToken } : {}),
      });
    } else {
      connect();
    }
  }

  window.addEventListener('online', syncRoom);
  window.addEventListener('pageshow', () => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.lastPongAt = Date.now();
      sendOnSocket(state.ws, { type: 'ping' });
    }
    syncRoom();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.lastPongAt = Date.now();
        sendOnSocket(state.ws, { type: 'ping' });
      }
      syncRoom();
    }
  });

  // ---------- 启动 ----------
  connect();
})();
