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
const { execFile } = require('node:child_process');

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

// 端口来源优先级：guard.dshPorts 数组 > guard.dshPort 单值（旧配置，向后兼容）> 默认列表。
// 默认列表覆盖两种常见 DSH：`npx dsh web`（3080）与桌面版（19387），
// 于是两个 DSH 之间来回切换时本地端都能正确判定，不需要再手改配置。
const GUARD_DEFAULTS = { host: '127.0.0.1', ports: [3080, 19387], pollMs: 3000 };

function normalizePort(n) {
  const v = Number(n);
  return (Number.isInteger(v) && v > 0 && v < 65536) ? v : null;
}

function readGuardConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(PETS_FILE, 'utf8')) || {}; } catch { /* 用默认 */ }
  const g = (raw.guard && typeof raw.guard === 'object') ? raw.guard : {};

  let ports = [];
  if (Array.isArray(g.dshPorts)) {
    ports = g.dshPorts.map(normalizePort).filter(function (p) { return p !== null; });
  } else if (normalizePort(g.dshPort)) {
    ports = [normalizePort(g.dshPort)];
  }
  if (ports.length === 0) ports = GUARD_DEFAULTS.ports.slice();

  return {
    enabled: g.enabled !== false,
    host: (typeof g.dshHost === 'string' && g.dshHost) ? g.dshHost : GUARD_DEFAULTS.host,
    ports: ports,
    pollMs: Number(g.pollMs) >= 500 ? Number(g.pollMs) : GUARD_DEFAULTS.pollMs,
  };
}

/**
 * 探测 DSH 的 pet 端点。
 * cb({ active, size })：
 *   active = DSH 那边是否存在 display 为 desktop/both 的宠物（决定本地版是否让位）
 *   size   = 那些宠物的尺寸（用于本地端跟随同步；取不到为 null）
 */
/** 探测单个端口的 pet 端点。reachable = 该端口确实有 HTTP 应答（用于区分「不是 DSH」和「没服务」） */
function probeOnePort(host, port, cb, timeoutMs) {
  let settled = false;
  const finish = function (v) { if (!settled) { settled = true; cb(v); } };
  const req = http.get({
    host: host,
    port: port,
    path: PREFIX + '/config',
    timeout: timeoutMs > 0 ? timeoutMs : 1500,
    headers: { Accept: 'application/json' },
  }, function (res) {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (c) {
      body += c;
      if (body.length > 400000) { req.destroy(); finish({ active: false, size: null, reachable: true }); }
    });
    res.on('end', function () {
      if (res.statusCode !== 200) { finish({ active: false, size: null, reachable: true }); return; }
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
        finish({ active: active, size: size, reachable: true });
      } catch { finish({ active: false, size: null, reachable: true }); }
    });
  });
  req.on('error', function () { finish({ active: false, size: null, reachable: false }); });
  req.on('timeout', function () { req.destroy(); finish({ active: false, size: null, reachable: false }); });
}

// 自动发现的限频（避免每次轮询都扫一遍）。发现的端口只记在内存里，
// 不动用户的 pets.json —— 免得把配置写坏。
let lastDiscoverAt = 0;
const DISCOVER_COOLDOWN_MS = 60000;

/**
 * 兜底自动发现：配置里的端口都没找到活跃 DSH 时，用 netstat 列出本机所有 TCP
 * 监听端口，逐个探测 pet 端点；找到就把端口加进 cfg.ports，本次运行后续轮询直接命中。
 * 这样即使 DSH 换到 3080 / 19387 之外的端口（或同时开着多个），也不需要再手改配置。
 */
function discoverDshPort(cfg, cb) {
  const now = Date.now();
  if (now - lastDiscoverAt < DISCOVER_COOLDOWN_MS) { cb(null); return; }
  lastDiscoverAt = now;

  execFile('netstat', ['-ano', '-p', 'TCP'], { timeout: 5000, windowsHide: true }, function (err, stdout) {
    if (err || !stdout) { cb(null); return; }
    // 必须排除「本地端自己的服务端口」：它也提供 /dsh-pet-7340/config，
    // 不排除的话自动发现会探到自己、误判「DSH 可用」，于是本地端让位，
    // 而万一 DSH 端其实没加载插件，就会两只桌宠都不显示。
    const own = (function () {
      try { return Number(new URL(process.env.DSH_PET_CONFIG_URL || '').port) || 0; } catch { return 0; }
    })();
    if (own) log('守卫：自动发现将跳过本地端自己的端口 ' + own);

    const cand = [];
    String(stdout).split(/\r?\n/).forEach(function (line) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i);
      if (!m) return;
      const p = normalizePort(m[1]);
      if (p !== null && p !== own && cfg.ports.indexOf(p) < 0 && cand.indexOf(p) < 0) cand.push(p);
    });
    log('守卫：配置端口 ' + cfg.ports.join('/') + ' 均无活跃 DSH → 自动发现（本机监听端口 ' + cand.length + ' 个）');

    // 并发探测（同时 8 个），并用更短的超时：串行 36 个端口各等 1.5s 会让兜底拖到十几秒，
    // 期间本地端会先冒出来再隐藏、闪一下。
    const CONCURRENCY = 8;
    const DISCOVER_TIMEOUT_MS = 700;
    let next = 0;
    let running = 0;
    let done = false;
    const finish = function (v) { if (!done) { done = true; cb(v); } };

    function pump() {
      if (done) return;
      while (running < CONCURRENCY && next < cand.length) {
        const port = cand[next++];
        running++;
        probeOnePort(cfg.host, port, function (r) {
          running--;
          if (done) return;
          if (r.active) {
            cfg.ports.push(port);
            log('守卫：自动发现 DSH 在端口 ' + port + '（已加入本次运行的优先列表）');
            finish({ active: true, size: r.size, port: port });
            return;
          }
          pump();
        }, DISCOVER_TIMEOUT_MS);
      }
      if (running === 0 && next >= cand.length) {
        log('守卫：自动发现未找到 DSH');
        finish(null);
      }
    }
    pump();
  });
}

/**
 * 探测 DSH 的 pet 端点（多端口）。
 * cb({ active, size })：
 *   active = DSH 那边是否存在 display 为 desktop/both 的宠物（决定本地版是否让位）
 *   size   = 那些宠物的尺寸（用于本地端跟随同步；取不到为 null）
 */
function probeDshPet(cfg, cb) {
  const ports = cfg.ports.slice();
  let idx = 0;
  let bestSize = null;

  function step() {
    if (idx >= ports.length) {
      // 配置里的端口都没活跃 DSH → 自动发现兜底
      discoverDshPort(cfg, function (found) {
        if (found) cb(found);
        else cb({ active: false, size: bestSize });
      });
      return;
    }
    const port = ports[idx++];
    probeOnePort(cfg.host, port, function (r) {
      if (r.active) { cb({ active: true, size: r.size, port: port }); return; }
      if (bestSize === null && r.size) bestSize = r.size;
      step();
    });
  }
  step();
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
      log('守卫已启用：每 ' + cfg.pollMs + 'ms 探测 ' + cfg.host + ' 的端口 ' + cfg.ports.join('/')
        + '（都不通时自动发现），路径 ' + PREFIX + '/config');
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
  // ── 单实例锁 ────────────────────────────────────────────────────────────────
  // 双击两次 exe 会跑出两个实例，屏幕上就会同时出现两只桌宠。用 Electron 自带的
  // 具名锁避免：第二个实例拿不到锁就直接退出，并把已有实例的窗口叫到前面来。
  const electronApi = require('electron');
  if (!electronApi.app.requestSingleInstanceLock()) {
    log('已有实例在运行 → 本次启动退出（避免出现两只桌宠）');
    electronApi.app.exit(0);
    return;
  }
  electronApi.app.on('second-instance', function () {
    // 刻意「什么都不做」：窗口的显隐由守卫决定（DSH 可用时本地端必须让位）。
    // 早先这里调用了 w.show()/focus()，结果重复启动会把已让位隐藏的窗口重新拽出来，
    // 与 DSH 端同时显示 → 屏幕上出现两只桌宠。
    log('检测到重复启动 → 已忽略（窗口显隐交由守卫决定，不强制显示）');
  });

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
