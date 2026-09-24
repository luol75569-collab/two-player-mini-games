# AGENTS.md · 写给接手这个仓库的 AI

本文件是这个仓库的**约定与红线**。仓库主人不懂技术，所以：**不要指望有人能在 review 时拦住你**，护栏靠你自己守，靠 `npm test` 兜底。

改代码前先读完本文件；改完必须跑 `npm test`。

---

## 1. 项目概况

**一句话**：一个跑在局域网里的双人小游戏站（海龟汤 + 15×15 五子棋），两个人用手机浏览器输入 4 位房间号就能开局。

| 项 | 值 |
|---|---|
| 运行环境 | Node.js ≥ 16（开发机实测 v26） |
| 依赖 | 只有 `ws`（WebSocket 库）。没有前端依赖、没有构建步骤 |
| 前端 | 原生 HTML / CSS / JS + Canvas，由 `server.js` 直接当静态文件提供 |
| 数据 | 房间、恢复会话和对局都在内存里。进程重启 = 房间和对局清空，题库来自 `soups.json`；同一存活进程内临时断线默认保留 5 分钟 |
| 布局 | 移动端优先（手机竖屏是第一目标） |
| 许可 | MIT，可自由分发 |

启动：

```bash
npm install
npm start          # 默认监听 0.0.0.0:3000，端口可用环境变量 PORT 覆盖
```

自检：

```bash
npm test           # 冒烟测试，见第 6 节
```

---

## 2. 红线（最重要，不要碰）

每条都写了**为什么**和**怎么检查**。红线不是风格偏好，是「碰了这个项目就坏了」的东西。

### 红线 1：必须完全离线可用 —— 禁止任何外部 CDN / 网络字体 / 外链图片

**为什么**：两个人通常在同一 Wi-Fi 下用手机玩，可能根本没有外网。断网、内网、飞行模式下页面必须和联网时长得一模一样。README 也向用户承诺了「前端不依赖任何 CDN 或网络字体」。

**具体要求**：

- 字体只能用**系统字体栈**（`public/style.css` 顶部的 `--hand` / `--body` 变量）。禁止 `@font-face`、禁止 Google Fonts / 字体 CDN。
- 禁止 `<script src="https://…">`、`<link href="https://…">`、外链图片、外链图标库、外链 CSS。
- 纹理、涂鸦、插画一律用 **CSS 渐变 / 内联 SVG / data: URI**（`index.html` 里的 `doodle-*` 内联 SVG、favicon 的 `data:image/svg+xml` 就是正确做法）。
- 唯一的例外是 SVG 的 `xmlns="http://www.w3.org/2000/svg"` 命名空间字符串——那不是网络请求。
- 新增 npm 依赖前先问自己「能不能不加」。运行时依赖目前就是 `ws` 一个，这本身是特性。

**检查**：`npm test` 的【7】会扫 `public/` 下的外链引用、`@font-face` 和依赖清单；另外可以拔网线/关 Wi-Fi 打开页面，确认样式不塌。

### 红线 2：游戏规则必须服务端权威

**为什么**：前端代码跑在玩家浏览器里，玩家想改就能改。把胜负判定放到前端 = 谁都能作弊赢。README 向用户承诺「服务端权威判定，客户端改不了」。

**必须留在 `server.js` 里的**：

- 棋盘状态 `board`、轮次 `turn`、胜负与连线 `winner` / `winningLine`、落子计数 `moveCount`、颜色分配 `colors`（函数：`newGomoku` / `gomokuStateFor` / `checkWin`）。
- `handleGomokuMove()` 里的四道校验，**一条都不能删、不能放宽**：
  1. 对局是否已结束（`g.winner`）
  2. 落子的人是不是本局玩家 / 是不是轮到他（`g.turn !== color`）
  3. 坐标是不是 0–14 的整数
  4. 目标格是不是空的（`g.board[idx] !== EMPTY`）
- 先落子、再判胜负、最后广播的**顺序**：`game.gomoku` 是唯一事实来源。

**前端 `public/app.js` 只允许做两件事**：把服务端下发的 `gomoku_state` 画出来；把玩家点击换算成坐标后用 `gomoku_move` 发出去。禁止在 `app.js` 里自己判五连、自己改棋盘、自己切轮次、自己决定谁赢了。

**检查**：`npm test` 的【2】。测试会发非法落子并断言服务端拒绝，还会自己凑一条五连验证 `winner` / `winningLine` 由服务端给出。

### 红线 3：海龟汤汤底只能下发给汤主或揭晓后

**为什么**：汤底是这游戏的唯一秘密。猜题者打开 DevTools 看 WebSocket 消息就能看到答案的话，游戏直接废掉。`soupPublicState()` 里那个 `state.answer = null` 的分支是**安全边界**，不是随手写的。

**具体要求**：

- 汤底只能通过 `soupPublicState(room, viewerId)` 出去，判定条件是 `viewerId === s.hostId || s.phase === 'revealed'`。
- 禁止把 `SOUPS[i].answer` 直接塞进 `broadcast()` / `safeSend()` / `welcome` / `room_update` / 页面初始 HTML / 任何新的广播消息。
- 禁止用「反正前端不显示」来代替服务端过滤——数据一旦发到客户端就等于公开。
- 前端渲染汤底只有两个合法位置：汤主自己那块 `answerBox`，和 `phase === 'revealed'` 后的揭晓面板。

**检查**：`npm test` 的【3】【4】【5】。测试会遍历**猜题者收到的全部原始消息文本**，断言里面找不到汤底；换角色后再验一遍；揭晓后再反向验证一次（确保那个断言不是空转）。

### 红线 4：房间上限 2 人，第三人必须被拒绝

**为什么**：现在的两种游戏都是**双人回合制**——五子棋没有第三种颜色，海龟汤只有一个汤主一个猜题者。放第三人进来会让对局状态直接错乱。

**具体要求**：保留 `join_room` 分支里的这段拒绝逻辑，不要放宽、不要删：

```js
if (room.players.size >= 2 && !room.players.has(player.id)) {
  return sendError(ws, '房间已满（最多 2 人）。');
}
```

README 的待办里有「1 个汤主 + N 个猜题者」，那是**将来**的功能；真要做的时候，需要连同汤主/猜题者判定、日志、前端渲染一起改，不能只删这一行。

**检查**：`npm test` 的【1】。

### 红线 5：不改 WebSocket 消息类型名称与语义

**为什么**：前后端是硬耦合的，没有类型系统、没有版本协商、没有 schema 校验。`server.js` 的 `switch (msg.type)` 和 `public/app.js` 的 `switch (msg.type)` 必须一一对上，改一个名字而没改另一边，功能会**静默失效**（前端落到 `default: break`，什么提示都没有）。

**当前协议清单**（改协议必须前后端同步改、并更新本文件和 `README.md` 的协议表）：

| 方向 | 消息 |
|---|---|
| 服务端 → 客户端 | `welcome`（含只给本人的 `sessionToken`）、`error`、`room_update`（只给当前收件人的 `resumeToken`）、`room_left`、`peer_left`、`session_replaced`、`gomoku_state`、`soup_state`、`pong` |
| 客户端 → 服务端 | `create_room`、`join_room`（可带 `resumeToken`）、`leave_room`、`select_game`、`restart`、`ping`、`gomoku_move`、`soup_start`、`soup_question`、`soup_answer`、`soup_guess`、`soup_verdict`、`soup_reveal`、`soup_swap` |

规则：**可以新增**消息类型；**不要重命名**已有类型，**不要改变**已有字段的含义（例如 `youColor` 必须继续表示「收件人自己的颜色」，`isHost` 必须继续表示「收件人是不是汤主」）。新增消息时，在 `test/smoke.js` 里补一条断言。

---

## 3. 代码地图

```
game-hub/
├── package.json          # npm start / npm test；唯一依赖 ws
├── server.js             # 全部服务端逻辑（约 620 行，本项目的大脑）
├── soups.json            # 海龟汤题库（26 道，纯数据）
├── public/               # 前端，由 server.js 当静态文件提供
│   ├── index.html        # 4 个视图：大厅 / 房间 / 五子棋 / 海龟汤 + 内联 SVG 涂鸦
│   ├── style.css         # 手绘纸张风样式，移动端优先；字体栈变量在这里
│   ├── app.js            # WebSocket 客户端 + 状态 + Canvas 棋盘 + 海龟汤渲染
│   ├── icon.svg          # 应用图标（被 manifest 引用）
│   └── manifest.webmanifest  # PWA「添加到主屏幕」
├── test/
│   └── smoke.js          # 冒烟测试：起临时服务 + 模拟玩家 + 断言红线（npm test）
├── README.md             # 给用户看的说明（含协议表）
├── PLAN.md               # 初版功能计划书（历史文档）
├── UI-HANDDRAWN.md       # 手绘风 UI 改造计划书（历史文档）
└── LICENSE
```

### `server.js` 内部结构（按功能分区）

| 区域 | 内容 |
|---|---|
| 顶部常量 | `PORT`（读环境变量，默认 3000）、`PUBLIC_DIR`、`MIME` 表、加载 `soups.json` |
| 房间 | 内存 `Map<code, Room>`；`genRoomCode()` 生成 4 位数字房间号；`Room` 结构见文件里的注释块 |
| 通用工具 | `safeSend` / `broadcast` / `roomPlayers` / `sendError` / `roomUpdateFor` / `broadcastRoomUpdate` / `broadcastGameState` |
| 房间生命周期 | 主动 `leave_room` 立即离开；WebSocket 临时 close 保留席位/游戏 5 分钟并暂停操作；恢复或到期回收；主动离开/到期后剩余玩家回大厅 |
| 五子棋 | `newGomoku()`（随机先手，`turn: 1` 永远表示黑先）、`gomokuStateFor()`、`checkWin()`、`handleGomokuMove()` |
| 海龟汤 | `newSoup()`、**`soupPublicState()`（安全边界）**、`broadcastSoupState()`、`soupLog()`（日志上限 200 条） |
| 消息分发 | `handleMessage()` 一个大 `switch`，所有 `case` 都先检查「你在不在房间/在不在这个游戏里」 |
| 输入清洗 | `sanitizeName()`（≤16 字）、`sanitizeText()`（≤max 字），都过滤控制字符和 `<>`、`` ` `` |
| HTTP | `http.createServer`：`/api/info` 返回 `{ok, rooms, soups, lan}`；其余映射到 `public/`，并校验路径没有越出 `PUBLIC_DIR` |
| WebSocket | `WebSocketServer({ server, path: '/ws' })`；连上即发只给本人的随机 `sessionToken`；`message` 超过 8KB 直接拒绝；30 秒传输层心跳 + 前端应用层 ping/pong 清理死连接 |

### `public/app.js` 内部结构

- `connect()` / `scheduleReconnect()`：连接超时、应用层心跳、带随机抖动的指数退避重连，恢复后用 `localStorage` 里的房间号和恢复凭证自动 `join_room`；`online` / `visibilitychange` / `pageshow` 会主动探测。
- `handleServer(msg)`：唯一的服务端消息入口；`gomoku_state` / `soup_state` 到达时切页并渲染。
- 大厅：`createBtn` / `joinBtn`（房间号必须是 4 位数字才发请求）。
- 五子棋：`setupCanvas()` 按 `devicePixelRatio` 适配、`drawBoard()`、`drawStone()`、`boardPosFromEvent()`；Pointer Events 用轻点抬起落子，滑动/取消/多指不落子。
- 海龟汤：`renderSoup()` 按 `isHost` / `phase` 决定显示汤主面板、猜题者面板还是揭晓面板。

### `test/smoke.js` 内部结构

`TestClient`（收集消息 + `waitFor(断言谓词)` 带超时）+ 各场景函数 + `check(条件, 中文描述)` 计数。它在**随机空闲端口**上拉起 `server.js` 子进程，结束（含失败、超时、Ctrl+C）时一定杀进程，不会留下占端口的残留进程。

---

## 4. 数据格式：`soups.json`

一个 JSON 数组，每项是一道汤：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `title` | ✅ | string | 题目名，用于列表和页面标题，不要重复 |
| `surface` | ✅ | string | **汤面**：给猜题者看的谜面 |
| `answer` | ✅ | string | **汤底**：只发给汤主，揭晓后才公开（红线 3） |
| `hints` | ❌ | string[] | 给汤主的提示。与汤底同一道安全边界：只发给汤主/揭晓后（红线 3） |

示例（照抄这个形状）：

```json
{
  "title": "雨夜搭车",
  "surface": "男人雨夜开车，看到路边三个人招手……",
  "answer": "他把车钥匙交给救命恩人，让恩人开车送老人去医院……",
  "hints": ["他不一定要自己开车", "车可以借给别人"]
}
```

**规则**：

- **不许改字段名**，不许改字段类型。前端和服务端都按这些名字读。
- 新增题**追加到数组末尾**（避免和别人的改动打架）。
- 保持合法 JSON：**不能有注释、不能有尾逗号**，UTF-8 编码。
- 汤底要写清楚「为什么」，别写「无」「不知道」这种占位符——猜题者揭晓后会看到它。
- 每项都应该是**独立**的谜题，不要和已有 `title` 重名。

**检查**：`npm test` 的【7】会逐项校验 `title` / `surface` / `answer` 非空、`hints` 是字符串数组；`soups.json` 解析失败时 `server.js` 会退化成一道「题库缺失」的占位题（不会崩，但游戏没法玩），所以 JSON 语法错误必须避免。

---

## 5. 不要做的事

- ❌ 不要引入构建步骤（webpack / vite / TypeScript / Babel / 打包框架）。文件存进去就能跑是本项目的核心体验。
- ❌ 不要引入前端框架（React / Vue / Tailwind CDN…）。
- ❌ 不要加数据库、账号、登录、云端存储。房间状态在内存里就是设计，不是缺陷。
- ❌ 不要把游戏规则搬到前端（红线 2）。
- ❌ 不要为了「好看」引入任何外部资源（红线 1）。
- ❌ 不要**为了让测试变绿**去删断言、放宽断言或注释掉测试。测试是唯一的护栏，拆护栏比修 bug 危险得多。
- ❌ 不要用 3000 端口跑测试——那是用户正在用的服务；测试必须用随机空闲端口或 `PORT` 环境变量。
- ❌ 不要顺手重构无关代码。改动面越小，越容易被验证。

---

## 6. 改完之后怎么自检（提交前必须全做）

```bash
npm test                                        # 1. 冒烟测试，必须全绿（当前 82 项断言，退出码 0）
node --check server.js && node --check public/app.js && node --check test/smoke.js   # 2. 语法
```

3. **手动过一遍**：`npm start`，浏览器开两个无痕窗口 → 一个「创建房间」、一个用房间号「加入」→ 下一盘五子棋（确认双方棋盘同步、非法落子没反应）→ 暂停/刷新其中一页后确认原棋盘和身份恢复、断线期间不能落子 → 开一局海龟汤（**确认猜题者那边看不到汤底**，汤主能回答，揭晓后双方都能看到）。
4. **手机尺寸**：DevTools 切到 375×812 看有没有横向滚动；按钮是否好点。
5. 如果改动涉及用户可见的行为，顺手更新 `README.md`（尤其是协议表和目录结构）。

提交前清单：

- [ ] `npm test` 退出码为 0（不是「看起来差不多」）
- [ ] `node --check` 三个文件都通过
- [ ] 没新增依赖，没引入任何外链资源
- [ ] 服务端仍然是棋盘 / 轮次 / 胜负 / 汤底的唯一权威
- [ ] 协议（消息名、字段语义）没变，或者前后端 + `README.md` + `test/smoke.js` 一起变了
- [ ] 新增了功能就补了断言；没有删改已有断言
- [ ] `soups.json` 仍然是合法 JSON，字段名没动
- [ ] 移动端（375px）没有横向滚动，点击区 ≥ 44px

---

## 7. 移动端要求（改 UI 必须满足）

1. **点击区 ≥ 44×44 CSS px**：`.btn` 已经是 `min-height:46px` + `min-width:44px`，`.btn-small` 是 `min-height:44px`，输入框 `min-height:46px`。新按钮请直接复用 `.btn` 系列 class，不要自己写更小的尺寸；图标按钮必须显式给宽高。
2. **375px 宽度不能横向滚动**：`html,body` 上的 `overflow-x:clip;overflow-y:visible` 是**兜底**，不是许可证。新增元素要自己保证不溢出（用 `flex-wrap`、`min-width:0`、`max-width:100%`、`clamp()`）。做法：DevTools 设 375×812，在 console 里跑 `document.documentElement.scrollWidth` 必须 ≤ 375；真机再确认一次。
3. **必须支持触摸**：
   - 棋盘用 Pointer Events 同时覆盖鼠标 / 触摸 / 触控笔：允许 `pan-y pinch-zoom` 原生纵向滚动；只有未超过移动阈值的单指轻点在 `pointerup` 落子，滑动、取消和多指都不能落子。不要改成只监听 `mousedown` 或依赖 `hover`。
   - 可点元素保留 `touch-action:manipulation`（消除移动端 300ms 点击延迟）。
   - 输入框 `font-size` 不要小于 16px，否则 iOS Safari 会自动放大页面。
   - 不要用 hover 作为唯一的交互反馈。
4. 页面用 `env(safe-area-inset-*)` 避开 iPhone 刘海/底部横条，新增固定定位元素时保持这个习惯。

---

## 8. 测试怎么扩写

`test/smoke.js` 是零额外依赖的（只用 Node 内置模块 + 项目已有的 `ws`），新增功能时按已有风格加断言：

```js
check(实际值 === 期望值, '一句中文说明这个断言在保证什么', '失败时打印的调试信息（可选）');
```

约定：

- 测试**串行**执行：`await` 完一条断言再发下一个刺激；`waitFor(pred)` 有 4 秒上限，整体有 90 秒兜底，所以不会永久挂起。
- 需要多条消息时，等**双方客户端**的状态都到齐再继续（`playMove()` 就是这么做的），避免竞态。
- 断言失败**不抛异常**，会记进 `failures` 并在最后汇总；只有「等消息超时」才会中断测试。两种都会以非 0 退出码结束。
- 涉及安全边界（汤底、权限）时，除了断言字段，还要对**原始消息文本**（`client.rawTexts`）做包含性检查——字段改名/换个位置藏答案都能被抓住。

---

## 9. 已知问题（已发现，未修）

接手前应当知道：

1. ~~**`hints` 会下发给猜题者**~~ —— **已修复**。旧版 `soupPublicState()` 无条件下发 `hints`，猜题者的 WebSocket 消息里带着「给汤主的提示」。现在 `hints` 与汤底走同一道安全边界：默认 `[]`，只有 `isHost || phase === 'revealed'` 才填充。`test/smoke.js` 里有 3 条断言守着（猜题者 hints 为空、汤主拿到字符串数组、原始消息文本不含提示内容），**不要**把 `hints` 重新挪回 `state` 字面量里。
2. **房间和题库都在内存里**：`server.js` 进程重启后所有房间、对局、聊天记录清零（这是设计，不是 bug）。
3. **断线恢复有边界**：v0.2 把随机恢复凭证保存在客户端 `localStorage`，同一存活 Node 进程内可恢复原 `playerId`、席位和对局；主动离开、恢复期限到期、服务重启或多实例切换后无法恢复。恢复凭证不能跨房间使用，第三人不能占用被保留的席位。
4. **没有 CI**：仓库没有配置 GitHub Actions，`npm test` 是唯一的自动化验证手段。改动后请务必本地跑通再提交。
