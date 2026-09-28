'use strict';
/**
 * dsh-pet 独立版启动器 —— 让桌宠脱离 DSH 单独运行。
 *
 * 【原理】对齐官方 helper 的两条数据通道：
 *   官方路径：DSH 宿主 spawn `electron.exe <helper>/main.js`，注入 DSH_PET_BRIDGE=1 走管道桥，
 *            并由宿主的 webServer 提供 /dsh-pet-7340/* 端点（config / thumb / font / pic）。
 *   helper 在没有 DSH_PET_BRIDGE 时**回落为「渲染端直接 HTTP 访问」**——constants.js 里
 *            BASE = new URL(configUrl).origin + '/dsh-pet-7340'，素材走 BASE/thumb/<根>/<名>.<ext>。
 *   于是本启动器只需三件事：
 *     ① 在 127.0.0.1 随机端口起一个小服务，提供与宿主同形的 config 与素材路径；
 *     ② 注入 DSH_PET_CONFIG_URL / DSH_PET_PETS，并删掉 DSH_PET_BRIDGE、DSH_PET_HOST_PID；
 *     ③ require('./main.js') —— 官方 helper 主进程一行未改。
 *   不注入 DSH_PET_HOST_PID 是关键：host-liveness 的 parseHostPid 会返回 0，于是
 *   kill(pid,0) 存活探测整个跳过（源码注释：「宁可留着一个桌宠等人来关」），
 *   桌宠不会因为「找不到宿主」而自杀。
 *
 * 【能力边界】余额 / 碎碎念 / 对话 / 工作状态联动都依赖 DSH 的 LLM 与 provider 凭据，
 *   独立版没有宿主，故在 pets.json 里把这三个开关关掉，并在本服务上给出明确的
 *   「不可用」应答（而不是 404 让前端反复重试）。独立版 = 纯动画与交互的桌宠。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const ASSETS_DIR = path.join(APP_DIR, 'assets');
const CONFIG_JSONC = path.join(ASSETS_DIR, 'config.jsonc');
const PETS_FILE = path.join(APP_DIR, 'pets.json');
const LOG_FILE = path.join(APP_DIR, 'dsh-pet.log');
const PREFIX = '/dsh-pet-7340';

// ── DPI 探测子进程旁路 ──────────────────────────────────────────────────────
// helper 会 execFileSync(process.execPath, [__filename]) 并置 DSH_PET_DPI_PROBE=1，只为读出
// 主屏缩放后退出。那个实例同样会加载本文件，但它不该建窗口、更不该再起一个服务：
// 直接进入 helper 自己的探测分支。
if (process.env.DSH_PET_DPI_PROBE === '1') {
  require('./main.js');
  return;
}

// 以纯 Node 方式跑（ELECTRON_RUN_AS_NODE）时 Electron 不提供 GUI，提前给出可读错误。
if (process.env.ELECTRON_RUN_AS_NODE) {
  process.stderr.write('dsh-pet: 请直接双击 dsh-pet.exe（当前以 ELECTRON_RUN_AS_NODE 启动，没有 GUI）\n');
  process.exit(3);
}

function log() {
  try {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + parts.join(' ') + '\n');
  } catch {
    /* 日志写不进去不影响桌宠运行 */
  }
}

// ── JSONC → JSON（config.jsonc 带 // 与块注释、尾随逗号，JSON.parse 读不了）──
function parseJsonc(text) {
  const src = text.replace(/^\uFEFF/, '');
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += n === undefined ? '' : n; i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// ── 独立版宠物配置 ─────────────────────────────────────────────────────────
const FALLBACK_PETS = [{
  id: 'main',
  size: 462,
  balanceEnabled: false,
  whisperEnabled: false,
  workStatusEnabled: false,
  display: 'desktop',
  position: { corner: 'top-right', marginX: 24, marginY: 100 },
}];

function readPetConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(PETS_FILE, 'utf8'));
    if (Array.isArray(j.pets) && j.pets.length > 0) return j.pets;
    log('pets.json 中没有宠物条目，使用内置默认');
  } catch (e) {
    log('pets.json 读取/解析失败:', e.message, '- 使用内置默认');
  }
  return FALLBACK_PETS;
}

// ── DSH 优先守卫 ───────────────────────────────────────────────────────────
// 需求：DSH 那边能显示桌宠时，本地版让位；DSH 不在（或那边根本不显示桌宠）时，
// 本地版接管。这样「DSH 优先、本地兜底」，两者不会同时出现在屏幕上。
//
// 判定方式不是「DSH 进程是否在跑」，而是更精确的一条：探测 DSH 的 pet 端点
// /dsh-pet-7340/config，只有当它能返回 200、且其中存在 display 为 desktop/both
// 的宠物时，才认为「DSH 那边真的会显示桌宠」。这样即使 DSH 开着但插件没装、
// 或插件被设成只在浏览器显示，本地版依然会顶上，不会出现两边都没有桌宠的空档。

const GUARD_DEFAULTS = { host: '127.0.0.1', port: 3080, pollMs: 3000 };

function readGuardConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(PETS_FILE, 'utf8')) || {}; } catch { /* 用默认 */ }
  const g = (raw.guard && typeof raw.guard === 'object') ? raw.guard : {};
  return {
    enabled: g.enabled !== false,
    host: (typeof g.dshHost === 'string' && g.dshHost) ? g.dshHost : GUARD_DEFAULTS.host,
    port: Number(g.dshPort) > 0 ? Number(g.dshPort) : GUARD_DEFAULTS.port,
    pollMs: Number(g.pollMs) >= 500 ? Number(g.pollMs) : GUARD_DEFAULTS.pollMs,
  };
}

/**
 * 探测 DSH 的 pet 端点。
 * cb({ active, size })：
 *   active = DSH 那边是否存在 display 为 desktop/both 的宠物（决定本地版是否让位）
 *   size   = 那些宠物的尺寸（用于本地端跟随同步；取不到为 null）
 */
function probeDshPet(cfg, cb) {
  let settled = false;
  const finish = function (v) { if (!settled) { settled = true; cb(v); } };
  const req = http.get({
    host: cfg.host,
    port: cfg.port,
    path: PREFIX + '/config',
    timeout: 1500,
    headers: { Accept: 'application/json' },
  }, function (res) {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (c) {
      body += c;
      if (body.length > 400000) { req.destroy(); finish({ active: false, size: null }); }
    });
    res.on('end', function () {
      if (res.statusCode !== 200) { finish({ active: false, size: null }); return; }
      try {
        const j = JSON.parse(body);
        let active = false;
        let size = null;
        Object.keys(j).forEach(function (k) {
          const pets = (j[k] && j[k].pets) || [];
          pets.forEach(function (p) {
            const d = String((p && p.display) || '');
            if (d === 'desktop' || d === 'both') {
              active = true;
              const s = Number(p && p.size);
              if (size === null && s > 0) size = s;
            }
          });
        });
        finish({ active: active, size: size });
      } catch { finish({ active: false, size: null }); }
    });
  });
  req.on('error', function () { finish({ active: false, size: null }); });
  req.on('timeout', function () { req.destroy(); finish({ active: false, size: null }); });
}

/** 本地当前配置里第一只宠物的尺寸 */
function readLocalSize() {
  const pets = readPetConfig();
  const s = Number(pets && pets[0] && pets[0].size);
  return s > 0 ? s : 462;
}

/** 把尺寸写回 pets.json（保留 guard 等其它字段） */
function writeLocalSize(size) {
  try {
    const raw = JSON.parse(fs.readFileSync(PETS_FILE, 'utf8'));
    if (Array.isArray(raw.pets) && raw.pets.length > 0) {
      raw.pets[0].size = size;
      fs.writeFileSync(PETS_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      return true;
    }
  } catch (e) {
    log('写回尺寸失败:', e.message);
  }
  return false;
}

/**
 * 用新尺寸刷新本地桌宠。
 * 直接整体重启：窗口的初始尺寸来自 DSH_PET_PETS（启动时读取），换尺寸必须让 helper
 * 重新建窗，reload 页面只能改渲染内容、改不了这个初始尺寸。重启时机发生在「DSH 调出」
 * 那一刻，此时本地端本来就处于隐藏状态，所以重启对用户完全无感。
 */
function restartLocalPet() {
  try {
    const app = require('electron').app;
    log('重启本地桌宠以应用新尺寸…');
    app.relaunch();
    app.exit(0);
  } catch (e) {
    log('重启本地桌宠失败:', e.message);
  }
}

function setupGuard() {
  const cfg = readGuardConfig();
  if (!cfg.enabled) { log('守卫已关闭（guard.enabled=false）：本地桌宠常驻显示'); return; }
  let lastActive = null;
  try {
    const electron = require('electron');
    const app = electron.app;
    const BrowserWindow = electron.BrowserWindow;

    const apply = function (info) {
      const active = info.active;

      // 只在「可用性翻转」的那一次动作 —— 这正好满足「只在每次网页端调出时同步/刷新一次」：
      // DSH 持续可用期间不再做任何刷新。
      if (active === lastActive) return;
      const prev = lastActive;
      lastActive = active;

      const wins = BrowserWindow.getAllWindows();

      if (active) {
        // ① DSH 调出 → 先对齐尺寸（仅当真的不同才刷），② 再让位隐藏。
        const local = readLocalSize();
        const remote = info.size;
        if (remote && remote !== local) {
          if (writeLocalSize(remote)) {
            log('守卫：DSH 尺寸 ' + remote + ' ≠ 本地 ' + local + ' → 立即刷新本地桌宠');
            wins.forEach(function (w) { if (!w.isDestroyed()) w.hide(); });
            restartLocalPet();
            return;
          }
        } else {
          log('守卫：DSH 尺寸 ' + (remote || '(未知)') + ' 与本地一致(' + local + ')，不刷新');
        }
        wins.forEach(function (w) { if (!w.isDestroyed()) w.hide(); });
        log('守卫：DSH 桌宠可用 → 本地桌宠让位（隐藏 ' + wins.length + ' 个窗口）');
      } else {
        wins.forEach(function (w) { if (!w.isDestroyed()) w.show(); });
        log((prev === null ? '守卫：启动时未检测到 DSH 桌宠' : '守卫：DSH 桌宠不可用')
          + ' → 本地桌宠接管（显示 ' + wins.length + ' 个窗口）');
      }
    };

    app.whenReady().then(function () {
      // 等 helper 把窗口建出来，再判定第一轮
      setTimeout(function () {
        probeDshPet(cfg, apply);
        const t = setInterval(function () { probeDshPet(cfg, apply); }, cfg.pollMs);
        if (t.unref) t.unref();
      }, 2000);
      log('守卫已启用：每 ' + cfg.pollMs + 'ms 探测 ' + cfg.host + ':' + cfg.port + PREFIX + '/config');
    });
  } catch (e) {
    log('守卫初始化失败:', e.message);
  }
}

/**
 * 对齐宿主 readAllConfig 的返回形状：{ <种类名>: { ...完整配置 } }
 * （renderer 用 S.flattenConfigPets(merged) 拍平，并读 merged.main.physics / eventsRefreshSec）
 */
function buildConfig() {
  let base = {};
  try {
    base = parseJsonc(fs.readFileSync(CONFIG_JSONC, 'utf8'));
  } catch (e) {
    log('config.jsonc 解析失败:', e.message);
  }
  base.pets = readPetConfig();
  return { main: base };
}

// ── 静态素材 ───────────────────────────────────────────────────────────────
const MIME = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function sendJson(res, obj, status) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 带 Range 支持（<video> 会发 bytes=0-，只给 200 时 Chromium 偶发不播） */
function sendFile(req, res, file) {
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { sendJson(res, { error: 'asset not found' }, 404); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
      let end = (m[1] === '' || m[2] === '') ? st.size - 1 : Number(m[2]);
      if (!isFinite(start) || start < 0) start = 0;
      if (!isFinite(end) || end >= st.size) end = st.size - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file, { start: start, end: end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ── 路由 ───────────────────────────────────────────────────────────────────
// 请求统计（写进日志，用于排障：能看出渲染端有没有真的在拉素材、有没有在反复重试 config）
let configHits = 0;
let thumbHits = 0;
const thumbSeen = new Set();

function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const p = decodeURIComponent(url.pathname);
  if (p.indexOf(PREFIX) !== 0) { sendJson(res, { error: 'not found' }, 404); return; }
  const rest = p.slice(PREFIX.length);
  let m;

  if (rest === '/config' || rest === '/config.jsonc') {
    configHits++;
    if (configHits <= 3) log('REQ /config (#' + configHits + ')');
    sendJson(res, buildConfig());
    return;
  }

  // 动画素材：BASE + '/thumb/' + <素材根> + '/' + <动画名> + <扩展名>
  // 素材根按 assetRoot 或宠物 id 回落（sprite.js），独立版统一指向包内 webm 池。
  if ((m = /^\/thumb\/[^/]+\/(.+)$/.exec(rest))) {
    const asset = path.basename(m[1]);
    thumbHits++;
    if (thumbSeen.size < 10 && !thumbSeen.has(asset)) {
      thumbSeen.add(asset);
      log('REQ thumb ' + asset);
    }
    sendFile(req, res, path.join(ASSETS_DIR, 'webm', asset));
    return;
  }
  if ((m = /^\/font\/(.+)$/.exec(rest))) { sendFile(req, res, path.join(ASSETS_DIR, 'fonts', path.basename(m[1]))); return; }
  if ((m = /^\/pic\/(.+)$/.exec(rest))) { sendFile(req, res, path.join(ASSETS_DIR, 'pic', path.basename(m[1]))); return; }
  if ((m = /^\/memes?\/(.+)$/.exec(rest))) { sendFile(req, res, path.join(ASSETS_DIR, 'memes', path.basename(m[1]))); return; }

  // 依赖 DSH 的端点：明确回「不可用」，避免前端静默重试或弹空白
  if (rest === '/balance' || rest === '/balance/trigger') { sendJson(res, { ok: false, reason: 'standalone' }); return; }
  if (rest === '/whisper' || rest === '/whisper/trigger') { sendJson(res, { enabled: false, text: '', seq: 0 }); return; }
  if (rest === '/work-status') { sendJson(res, { status: null, ts: 0 }); return; }
  if (rest === '/broadcast') { sendJson(res, {}); return; }
  if (rest === '/chat') { sendJson(res, { error: 'standalone: 对话功能需要 DSH 运行' }, 501); return; }

  sendJson(res, { error: 'not found: ' + rest }, 404);
}

// ── 系统托盘 ───────────────────────────────────────────────────────────────
// 脱离 DSH 后没有任何宿主会来关闭桌宠，必须自带一个可见的退出入口。
function setupTray() {
  try {
    const electron = require('electron');
    const app = electron.app;
    const Tray = electron.Tray;
    const Menu = electron.Menu;
    const BrowserWindow = electron.BrowserWindow;
    const nativeImage = electron.nativeImage;
    const shell = electron.shell;

    app.whenReady().then(function () {
      let tray;
      try {
        const img = nativeImage.createFromPath(path.join(ASSETS_DIR, 'pic', 'notify-done.png'));
        tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
      } catch (e) {
        log('托盘创建失败:', e.message);
        return;
      }
      const rebuild = function () {
        const wins = BrowserWindow.getAllWindows();
        const visible = wins.some(function (w) { return w.isVisible(); });
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: visible ? '桌宠：显示中' : '桌宠：已隐藏', enabled: false },
          { type: 'separator' },
          {
            label: visible ? '隐藏桌宠' : '显示桌宠',
            click: function () {
              wins.forEach(function (w) { if (visible) { w.hide(); } else { w.show(); } });
              rebuild();
            },
          },
          { label: '打开日志', click: function () { shell.openPath(LOG_FILE); } },
          { type: 'separator' },
          { label: '退出', click: function () { app.exit(0); } },
        ]));
      };
      rebuild();
      tray.setToolTip('大肥鱼桌宠');
      log('托盘就绪');
    });
  } catch (e) {
    log('托盘初始化失败:', e.message);
  }
}

// ── 启动 ───────────────────────────────────────────────────────────────────
const server = http.createServer(handle);
server.on('error', function (e) { log('HTTP 服务错误:', e.message); });

server.listen(0, '127.0.0.1', function () {
  const port = server.address().port;
  const configUrl = 'http://127.0.0.1:' + port + PREFIX + '/config';
  const pets = readPetConfig().map(function (p) {
    return { id: String(p.id), size: Number(p.size) || 462 };
  });

  process.env.DSH_PET_CONFIG_URL = configUrl;
  process.env.DSH_PET_PETS = JSON.stringify(pets);
  delete process.env.DSH_PET_BRIDGE;    // 走「渲染端直接 HTTP」通道，而不是管道桥
  delete process.env.DSH_PET_HOST_PID;  // 不设 → host-liveness 跳过探测，不会自我退出
  delete process.env.ELECTRON_RUN_AS_NODE;

  log('--- 启动 ---');
  log('configUrl=' + configUrl);
  log('pets=' + process.env.DSH_PET_PETS);

  setupTray();
  setupGuard();          // DSH 优先：DSH 那边能显示桌宠时，本地版自动让位
  require('./main.js');  // 官方 helper 主进程，原样拉起
});
