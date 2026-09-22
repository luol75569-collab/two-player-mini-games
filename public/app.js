'use strict';

/* 双人小游戏站前端（原生 JS，无构建） */
(function () {
  // ---------- 工具 ----------
  const $ = (id) => document.getElementById(id);
  const PAGES = ['lobby', 'room', 'gomoku', 'soup'];

  function showPage(name) {
    for (const p of PAGES) $(p).classList.toggle('hidden', p !== name);
    window.scrollTo(0, 0);
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
    name: localStorage.getItem('gh_name') || '',
    players: [],
    game: null,
    gomoku: null, // {board, size, turn, winner, winningLine, youColor, players}
    soup: null,
    answerVisible: false,
    reconnectTimer: null,
    reconnectDelay: 1000,
  };

  $('nameInput').value = state.name;
  if (state.roomCode) $('joinCodeInput').value = state.roomCode;

  // ---------- WebSocket ----------
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
    const ws = new WebSocket(wsUrl());
    state.ws = ws;

    ws.onopen = () => {
      $('connBar').classList.add('hidden');
      state.reconnectDelay = 1000;
      // 断线重连后自动回到房间
      if (state.roomCode) {
        send({ type: 'join_room', code: state.roomCode, name: state.name });
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleServer(msg);
    };

    ws.onclose = () => {
      $('connBar').classList.remove('hidden');
      scheduleReconnect();
    };

    ws.onerror = () => { /* onclose 会跟进 */ };
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
      connect();
    }, state.reconnectDelay);
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(obj));
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
        break;
      case 'error':
        if (!$('lobby').classList.contains('hidden')) {
          $('lobbyError').textContent = msg.message || '出错了';
        } else {
          toast(msg.message || '出错了');
        }
        break;
      case 'room_update':
        onRoomUpdate(msg);
        break;
      case 'peer_left':
        toast(msg.message || '对方离开了房间');
        break;
      case 'gomoku_state':
        state.gomoku = msg;
        state.game = 'gomoku';
        renderGomoku();
        showPage('gomoku');
        break;
      case 'soup_state':
        state.soup = msg;
        state.game = 'soup';
        renderSoup();
        showPage('soup');
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  function onRoomUpdate(msg) {
    state.roomCode = msg.code;
    state.players = msg.players;
    state.game = msg.game;
    localStorage.setItem('gh_room', msg.code);

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
      chip.textContent = (p.id === state.playerId ? '我 · ' : '') + (p.name || `玩家${p.id}`);
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
    localStorage.removeItem('gh_room');
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
    const cssSize = canvas.clientWidth || 300;
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
  }

  function drawBoard() {
    if (!state.gomoku) return;
    setupCanvas();
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
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const { pad, cell } = boardMetrics;
    const x = Math.round((px - pad) / cell);
    const y = Math.round((py - pad) / cell);
    if (x < 0 || y < 0 || x > 14 || y > 14) return null;
    return { x, y };
  }

  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (!state.gomoku || state.gomoku.winner) return;
    const pos = boardPosFromEvent(ev);
    if (!pos) return;
    send({ type: 'gomoku_move', x: pos.x, y: pos.y });
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

    if (g.winner === 'draw') {
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
      const turnFlag = (!g.winner && g.turn === p.color) ? ' <span class="turn-flag">● 行棋中</span>' : '';
      span.innerHTML = `${dot}${escapeHtml(p.name)}${me}${turnFlag}`;
      playersEl.appendChild(span);
    }

    drawBoard();
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
      $('hostPending').textContent = pendingQ
        ? `猜题者问：「${s.lastQuestion.text}」—— 请回答：`
        : (s.phase === 'playing' ? '等待猜题者提问…' : '');
      document.querySelectorAll('.btn-answer').forEach((b) => { b.disabled = !pendingQ; });

      // 待判定最终推理
      const pendingGuess = s.lastGuess && !s.lastGuess.verdict;
      $('verdictBox').classList.toggle('hidden', !pendingGuess);
    }

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

  // ---------- 启动 ----------
  connect();
})();
