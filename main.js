'use strict';

const { app, BrowserWindow, ipcMain, Menu, session, safeStorage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// claude.ai sits behind Cloudflare, which blocks Node's fetch on sight of
// Electron's default headers. Every request below therefore rides in a real
// Chromium window with a Chrome user agent.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 한도에 가까울수록 자주 확인한다. 위에서부터 처음 걸리는 구간을 쓴다.
const REFRESH_STEPS = [
  { from: 90, ms: 1 * 60 * 1000 },
  { from: 80, ms: 3 * 60 * 1000 },
  { from: 0, ms: 5 * 60 * 1000 },
];
const DEFAULT_REFRESH_MS = REFRESH_STEPS[REFRESH_STEPS.length - 1].ms;

// 100% 도달 시 초기화 시각을 기다릴 때 쓰는 값
const RESET_GRACE_MS = 15 * 1000; // 초기화 직후를 노리기 위한 여유
const MAX_SLEEP_MS = 30 * 60 * 1000; // 한 번에 건너뛰는 최대 시간
const WIDTH = 112;
const HEIGHT = 60;
const MOCK = process.env.USEGE_CLAUDE_MOCK === '1';

let win = null;
let storePath = null;
let dragOrigin = null;

// Windows의 투명 창은 GPU 합성 경로에서 깜빡임이나 잔상이 생기는 사례가 잦다.
// 정지 화면에 가까운 위젯이라 CPU 렌더링 비용은 무시할 만하므로 꺼둔다.
app.disableHardwareAcceleration();

// ---------------------------------------------------------------- 저장소
// electron-store를 쓰지 않고 userData 아래 JSON 한 장으로 끝낸다.

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeStore(obj) {
  try {
    fs.writeFileSync(storePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[store] write failed:', e.message);
  }
}

function saveSessionKey(key) {
  const s = readStore();
  if (safeStorage.isEncryptionAvailable()) {
    s.sessionKey_encrypted = safeStorage.encryptString(key).toString('base64');
    delete s.sessionKey;
  } else {
    // 키체인을 못 쓰는 환경에서만. Windows에서는 사실상 발생하지 않는다.
    s.sessionKey = key;
  }
  writeStore(s);
}

function loadSessionKey() {
  const s = readStore();
  if (s.sessionKey_encrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.sessionKey_encrypted, 'base64'));
    } catch (e) {
      return null;
    }
  }
  return s.sessionKey || null;
}

// ---------------------------------------------------------------- 조회

function setSessionCookie(key) {
  return session.defaultSession.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: key,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true,
  });
}

// 차단당하면 JSON 대신 HTML이 돌아온다. 그 경우를 에러로 구분해 재로그인을 띄운다.
const BLOCKED = [
  ['Just a moment', 'CloudflareBlocked'],
  ['Enable JavaScript and cookies to continue', 'CloudflareChallenge'],
  ['<html', 'UnexpectedHTML'],
];

function fetchViaWindow(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!w.isDestroyed()) w.close();
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('Timeout')), timeoutMs);

    w.webContents.on('did-finish-load', async () => {
      try {
        const body = await w.webContents.executeJavaScript(
          'document.body.innerText || document.body.textContent'
        );
        for (const [pattern, name] of BLOCKED) {
          if (body.includes(pattern)) return finish(reject, new Error(name));
        }
        finish(resolve, JSON.parse(body));
      } catch (e) {
        finish(reject, new Error('InvalidJSON: ' + e.message));
      }
    });

    w.webContents.on('did-fail-load', (_e, code, desc) =>
      finish(reject, new Error(`LoadFailed ${code} ${desc}`))
    );

    w.loadURL(url);
  });
}

async function listOrgIds() {
  const orgs = await fetchViaWindow('https://claude.ai/api/organizations');
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('NoOrganizations');
  // API 전용 조직은 사용량 창이 없으므로 chat 가능한 것만 추린다.
  const chat = orgs.filter((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
  const list = chat.length ? chat : orgs;
  // 우리가 보려는 건 개인의 5시간 창이다. Team 조직은 그 값을 주지 않는 경우가
  // 있으므로 개인 조직을 먼저 본다. 어차피 아래에서 값이 나올 때까지 훑는다.
  const personal = list.filter((o) => o.raven_type !== 'team');
  const team = list.filter((o) => o.raven_type === 'team');
  return [...personal, ...team].map((o) => o.uuid || o.id).filter(Boolean);
}

// 5시간 창 값은 최상위 five_hour로 오기도 하고 limits 배열에 들어오기도 한다.
// 숫자가 아니면 null을 돌려준다 — 예전처럼 0으로 눙치면 "사용량 0%"와
// "값을 못 읽음"이 화면에서 구분되지 않는다.
function readFiveHour(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const pick = (percent, resetsAt) => {
    // Number(null)과 Number('')은 0이다. 값이 없는 것과 0%를 구분해야 하므로
    // 숫자나 숫자 문자열이 아니면 받지 않는다.
    if (typeof percent !== 'number' && typeof percent !== 'string') return null;
    if (typeof percent === 'string' && percent.trim() === '') return null;
    const n = Number(percent);
    if (!Number.isFinite(n)) return null;
    return { percent: n, resetsAt: toEpochMs(resetsAt) };
  };

  if (usage.five_hour) {
    const got = pick(usage.five_hour.utilization, usage.five_hour.resets_at);
    if (got) return got;
  }

  if (Array.isArray(usage.limits)) {
    const entry = usage.limits.find(
      (l) =>
        l &&
        typeof l.kind === 'string' &&
        l.kind.replace(/[-_\s]/g, '').toLowerCase().includes('fivehour')
    );
    if (entry) {
      const got = pick(entry.percent != null ? entry.percent : entry.utilization, entry.resets_at);
      if (got) return got;
    }
  }

  return null;
}

// 조직을 차례로 받아보고 5시간 창 값이 들어있는 첫 번째를 쓴다.
async function findUsage(orgIds) {
  let unauthorized = false;
  for (const orgId of orgIds) {
    const raw = await fetchViaWindow(`https://claude.ai/api/organizations/${orgId}/usage`);
    lastRaw = { orgId, at: new Date().toISOString(), raw };
    if (raw && raw.error) {
      unauthorized = true;
      continue;
    }
    const five = readFiveHour(raw);
    if (five) return { orgId, five };
  }
  if (unauthorized) throw new Error('Unauthorized');
  return null;
}

// claude.ai가 세션을 연장하며 새 sessionKey를 내려주는 경우가 있다. 저장본을
// 따라 갱신해두지 않으면, 다음 실행 때 낡은 키를 다시 심어 아직 쓸 수 있는
// 세션을 스스로 끊어버린다.
async function syncSessionKey(used) {
  try {
    const [cookie] = await session.defaultSession.cookies.get({
      url: 'https://claude.ai',
      name: 'sessionKey',
    });
    if (cookie && cookie.value && cookie.value !== used) saveSessionKey(cookie.value);
  } catch (e) {
    /* 갱신에 실패해도 조회 자체는 성공했으므로 넘어간다 */
  }
}

// resets_at은 epoch 초로도, ISO 문자열로도 올 수 있다.
function toEpochMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : parsed;
}

function send(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('usage', payload);
}

// 직전 조회 결과. 실패했거나 로그아웃 상태면 null로 두어 기본 주기로 돌아간다.
let lastPercent = null;
let lastResetsAt = null;
let lastRaw = null; // 마지막 /usage 응답 원본. 진단 저장에만 쓴다.
let refreshTimer = null;

function clearLast() {
  lastPercent = null;
  lastResetsAt = null;
}

function intervalFor(percent) {
  if (typeof percent !== 'number') return DEFAULT_REFRESH_MS;
  return REFRESH_STEPS.find((step) => percent >= step.from).ms;
}

function nextDelay() {
  // 창을 다 쓰면 초기화 전까지 값이 변할 수 없다. 그 사이의 조회는 전부
  // 헛수고이므로 초기화 시각까지 건너뛴다.
  if (lastPercent != null && lastPercent >= 100 && lastResetsAt) {
    const wait = lastResetsAt - Date.now() + RESET_GRACE_MS;
    // 절전/최대 절전으로 타이머가 밀리거나 resets_at이 엉뚱한 값일 때를 대비해
    // 상한을 둔다. 초기화가 멀면 이 간격으로 느슨하게 다시 확인한다.
    if (wait > 0) return Math.min(wait, MAX_SLEEP_MS);
  }
  return intervalFor(lastPercent);
}

// 고정 간격(setInterval) 대신 매 조회가 끝난 뒤 다음 시각을 다시 잡는다.
// 수동 새로고침도 이 경로를 타므로 직후에 또 조회되는 일이 없다.
function scheduleNext() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, nextDelay());
}

async function refresh() {
  try {
    await refreshOnce();
  } finally {
    scheduleNext();
  }
}

async function refreshOnce() {
  if (MOCK) {
    lastPercent = Number(process.env.USEGE_CLAUDE_MOCK_PCT) || 62;
    lastResetsAt = Date.now() + 2 * 3600 * 1000;
    return send({ state: 'ok', percent: lastPercent, resetsAt: lastResetsAt });
  }

  const key = loadSessionKey();
  if (!key) {
    clearLast();
    return send({ state: 'need-login' });
  }

  try {
    await setSessionCookie(key);

    const store = readStore();

    // 캐시해둔 조직을 먼저 본다. 거기서 값이 안 나오면 목록을 다시 받아
    // 나머지 조직을 훑는다 (계정에 조직이 여럿일 때).
    let found = store.organizationId ? await findUsage([store.organizationId]) : null;
    if (!found) {
      const ids = await listOrgIds();
      found = await findUsage(ids.filter((id) => id !== store.organizationId));
    }

    if (!found) {
      clearLast();
      return send({ state: 'error' });
    }

    if (store.organizationId !== found.orgId) {
      store.organizationId = found.orgId;
      writeStore(store);
    }

    lastPercent = found.five.percent;
    lastResetsAt = found.five.resetsAt;
    send({ state: 'ok', percent: lastPercent, resetsAt: lastResetsAt });

    await syncSessionKey(key);
  } catch (e) {
    console.error('[refresh]', e.message);
    clearLast();
    // 차단/비JSON 응답은 세션 만료일 가능성이 높으므로 재로그인을 안내한다.
    const expired = /Cloudflare|UnexpectedHTML|InvalidJSON|Unauthorized/.test(e.message);
    send({ state: expired ? 'need-login' : 'error' });
  }
}

// ---------------------------------------------------------------- 로그인
// 앱 안에 로그인 폼을 만들지 않는다. Cloudflare가 임베드 로그인을 차단하므로
// 진짜 claude.ai 로그인 페이지를 창으로 띄우고, sessionKey 쿠키가 생기는
// 순간을 쿠키 이벤트로 가로챈다. 그래서 로그인 수단(이메일/Google/Apple 등)에
// 전혀 의존하지 않는다.

const LOGIN_DOMAINS = [
  'claude.ai',
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
];

function openLoginWindow() {
  return new Promise((resolve) => {
    const lw = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Claude 로그인',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let captured = false;

    const onCookieChanged = (_e, cookie, _cause, removed) => {
      if (
        cookie.name === 'sessionKey' &&
        cookie.domain.includes('claude.ai') &&
        !removed &&
        cookie.value
      ) {
        captured = true;
        session.defaultSession.cookies.removeListener('changed', onCookieChanged);
        if (!lw.isDestroyed()) lw.close();
        resolve(cookie.value);
      }
    };

    // 피싱 방지: 로그인에 필요한 도메인 밖으로는 이동시키지 않는다.
    lw.webContents.on('will-navigate', (e, url) => {
      try {
        const host = new URL(url).hostname;
        const ok = LOGIN_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
        if (!ok) e.preventDefault();
      } catch (err) {
        e.preventDefault();
      }
    });
    lw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    session.defaultSession.cookies.on('changed', onCookieChanged);

    lw.on('closed', () => {
      session.defaultSession.cookies.removeListener('changed', onCookieChanged);
      if (!captured) resolve(null);
    });

    lw.loadURL('https://claude.ai/login');
  });
}

async function doLogin() {
  try {
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
  } catch (e) {
    /* 없으면 그만 */
  }
  const key = await openLoginWindow();
  if (!key) return;

  saveSessionKey(key);
  const store = readStore();
  delete store.organizationId; // 계정이 바뀌었을 수 있으므로 다시 찾는다
  writeStore(store);
  await refresh();
}

async function doLogout() {
  const store = readStore();
  delete store.sessionKey;
  delete store.sessionKey_encrypted;
  delete store.organizationId;
  writeStore(store);

  const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
  for (const c of cookies) {
    await session.defaultSession.cookies.remove('https://claude.ai', c.name);
  }
  await session.defaultSession.clearStorageData({
    storages: ['localstorage', 'cookies'],
    origin: 'https://claude.ai',
  });
  send({ state: 'need-login' });
}

// ---------------------------------------------------------------- 창

function isOnScreen(x, y) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height;
  });
}

function createWindow() {
  const store = readStore();
  let { x, y } = store;
  if (typeof x !== 'number' || typeof y !== 'number' || !isOnScreen(x, y)) {
    const a = screen.getPrimaryDisplay().workArea;
    x = a.x + a.width - WIDTH - 24;
    y = a.y + a.height - HEIGHT - 24;
  }

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function savePosition() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const store = readStore();
  store.x = b.x;
  store.y = b.y;
  writeStore(store);
}

// -webkit-app-region: drag 를 쓰면 Windows에서 그 영역이 캡션으로 취급돼
// 우클릭 메뉴가 뜨지 않는다. 그래서 드래그를 직접 구현한다.
ipcMain.on('drag-start', () => {
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    dragOrigin = { x: b.x, y: b.y };
  }
});

ipcMain.on('drag-move', (_e, dx, dy) => {
  if (!dragOrigin || !win || win.isDestroyed()) return;
  win.setPosition(dragOrigin.x + dx, dragOrigin.y + dy);
});

ipcMain.on('drag-end', () => {
  dragOrigin = null;
  savePosition();
});

function loginItemOptions() {
  // 포터블 빌드는 실행할 때마다 임시 폴더에 풀린다. process.execPath는 그
  // 임시 경로를 가리키므로 그대로 등록하면 다음 부팅 때 사라진 경로를 찾는다.
  // electron-builder가 넣어주는 원본 exe 경로를 쓴다.
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExe) return { path: portableExe };

  // 설치본은 기본값으로 충분하다.
  if (app.isPackaged) return {};

  // 개발 중에는 electron.exe로 실행하므로 앱 경로를 함께 넘겨야 한다.
  return { path: process.execPath, args: [app.getAppPath()] };
}

// 다른 PC에서 값이 비어 보일 때 실제 응답을 확인하려고 쓴다.
// 계정 식별자가 들어 있을 수 있으니 공유 전에 내용을 한 번 보는 편이 좋다.
async function saveDiagnostics() {
  const file = path.join(app.getPath('desktop'), 'usege-claude-diagnostics.json');
  try {
    let orgs = null;
    try {
      orgs = await fetchViaWindow('https://claude.ai/api/organizations');
    } catch (e) {
      orgs = { fetchError: e.message };
    }
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          version: app.getVersion(),
          loggedIn: !!loadSessionKey(),
          storedOrganizationId: readStore().organizationId || null,
          lastPercent,
          lastResetsAt,
          organizations: orgs,
          lastUsageResponse: lastRaw,
        },
        null,
        2
      )
    );
    shell.showItemInFolder(file);
  } catch (e) {
    console.error('[diagnostics]', e.message);
  }
}

ipcMain.on('menu', () => {
  const loggedIn = !!loadSessionKey();
  const template = [
    { label: '새로고침', click: () => refresh() },
    loggedIn
      ? { label: '로그아웃', click: () => doLogout() }
      : { label: 'Claude 로그인', click: () => doLogin() },
    { type: 'separator' },
    {
      label: '시작프로그램 등록',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
      click: (item) =>
        app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: item.checked }),
    },
    { label: '진단 정보 저장', click: () => saveDiagnostics() },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
});

ipcMain.on('refresh', () => refresh());

// ---------------------------------------------------------------- 수명주기

app.whenReady().then(() => {
  storePath = path.join(app.getPath('userData'), 'store.json');
  session.defaultSession.setUserAgent(CHROME_UA);

  createWindow();
  // refresh()가 끝나면서 스스로 다음 조회를 예약한다.
  win.webContents.once('did-finish-load', () => refresh());
});

app.on('window-all-closed', () => app.quit());
