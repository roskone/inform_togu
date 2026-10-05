'use strict';

const { app, BrowserWindow, Menu, ipcMain, net, shell, dialog, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_NAME = 'Расписание ТОГУ';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const FETCH_TIMEOUT_MS = 25000;

app.setName(APP_NAME);

let mainWindow = null;

// ───────────────────────────── хранилище ─────────────────────────────

function storePath(name) {
  return path.join(app.getPath('userData'), name);
}

function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(storePath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(name, data) {
  const file = storePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// ───────────────────────────── сеть ─────────────────────────────

function isHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
}

function detectCharset(contentType, bytes) {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = Buffer.from(bytes.slice(0, 4096)).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1].toLowerCase() : 'utf-8';
}

function decode(bytes, charset) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function fetchPage(url) {
  if (!isHttpUrl(url)) return { ok: false, error: 'Некорректная ссылка' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
      cache: 'no-store',
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const html = decode(bytes, detectCharset(res.headers.get('content-type'), bytes));
    if (!res.ok) return { ok: false, status: res.status, error: `Сервер ответил ${res.status}`, url: res.url };
    return { ok: true, status: res.status, url: res.url || url, html };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'Превышено время ожидания ответа' : humanNetError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function humanNetError(err) {
  const msg = String((err && err.message) || err);
  if (/ERR_INTERNET_DISCONNECTED/.test(msg)) return 'Нет подключения к интернету';
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return 'Не удалось найти сервер (DNS)';
  if (/ERR_CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT)|ERR_TIMED_OUT/.test(msg)) return 'Сайт не отвечает или сбросил соединение';
  if (/ERR_CERT|SSL/.test(msg)) return 'Ошибка защищённого соединения';
  return msg.replace(/^net::/, '');
}

// Запасной вариант: страница, которая дорисовывает расписание скриптами.
async function renderPage(url) {
  if (!isHttpUrl(url)) return { ok: false, error: 'Некорректная ссылка' };
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, images: false },
  });
  win.webContents.setUserAgent(USER_AGENT);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
    ]);
    // ждём, пока на странице появятся дни недели (или проходит защитная проверка сайта)
    const ready = "/понедельник|вторник|среда|четверг|пятница|суббота/i.test(document.body ? document.body.innerText : '')";
    for (let waited = 0; waited < 12000; waited += 500) {
      if (await win.webContents.executeJavaScript(ready).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 500));
    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
    return { ok: true, url: win.webContents.getURL(), html };
  } catch (err) {
    return { ok: false, error: humanNetError(err) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// ───────────────────────────── окно ─────────────────────────────

function createWindow() {
  const settings = readJSON('settings.json', {});
  const bounds = settings.windowBounds || {};
  const dark = settings.theme === 'light' ? false : settings.theme === 'system' ? nativeTheme.shouldUseDarkColors : true;

  mainWindow = new BrowserWindow({
    width: bounds.width || 560,
    height: bounds.height || 820,
    x: bounds.x,
    y: bounds.y,
    minWidth: 420,
    minHeight: 560,
    title: APP_NAME,
    show: false,
    backgroundColor: dark ? '#121212' : '#fcfcfc',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // ссылки открываем во внешнем браузере, навигацию внутри окна запрещаем
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.on('close', () => {
    const s = readJSON('settings.json', {});
    s.windowBounds = mainWindow.getBounds();
    writeJSON('settings.json', s);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(action) {
  if (mainWindow) mainWindow.webContents.send('menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [{
          label: APP_NAME,
          submenu: [
            { role: 'about', label: `О программе «${APP_NAME}»` },
            { type: 'separator' },
            { label: 'Настройки…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
            { type: 'separator' },
            { role: 'services', label: 'Службы' },
            { type: 'separator' },
            { role: 'hide', label: `Скрыть «${APP_NAME}»` },
            { role: 'hideOthers', label: 'Скрыть остальные' },
            { role: 'unhide', label: 'Показать все' },
            { type: 'separator' },
            { role: 'quit', label: `Завершить «${APP_NAME}»` },
          ],
        }]
      : []),
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выбрать все' },
      ],
    },
    {
      label: 'Расписание',
      submenu: [
        { label: 'Обновить', accelerator: 'CmdOrCtrl+R', click: () => send('refresh') },
        { type: 'separator' },
        { label: 'Сегодня', accelerator: 'CmdOrCtrl+T', click: () => send('today') },
        { label: 'Завтра', accelerator: 'CmdOrCtrl+Y', click: () => send('tomorrow') },
        { label: 'Предыдущий день', accelerator: 'CmdOrCtrl+[', click: () => send('prev') },
        { label: 'Следующий день', accelerator: 'CmdOrCtrl+]', click: () => send('next') },
        { type: 'separator' },
        { label: 'Открыть на сайте', click: () => send('open-site') },
        { label: 'Диагностика разбора…', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('debug') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'Настройки…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') }]),
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'resetZoom', label: 'Фактический размер' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полноэкранный режим' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
    { role: 'windowMenu', label: 'Окно' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ───────────────────────────── IPC ─────────────────────────────

ipcMain.handle('page:fetch', (_e, url) => fetchPage(url));
ipcMain.handle('page:render', (_e, url) => renderPage(url));

ipcMain.handle('state:load', () => ({
  settings: readJSON('settings.json', {}),
  cache: readJSON('cache.json', null),
}));

ipcMain.handle('settings:save', (_e, settings) => {
  const prev = readJSON('settings.json', {});
  writeJSON('settings.json', Object.assign({}, settings, { windowBounds: prev.windowBounds }));
  return true;
});

ipcMain.handle('cache:save', (_e, cache) => {
  writeJSON('cache.json', cache);
  return true;
});

ipcMain.handle('theme:set', (_e, theme) => {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
  return nativeTheme.shouldUseDarkColors;
});

ipcMain.handle('debug:export', async (_e, { html, json }) => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Сохранить страницу расписания для отладки',
    defaultPath: path.join(app.getPath('desktop'), `togu-rasp-${stamp}.html`),
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, html || '');
  if (json) fs.writeFileSync(filePath.replace(/\.html?$/i, '') + '.parsed.json', json);
  shell.showItemInFolder(filePath);
  return { ok: true, path: filePath };
});

ipcMain.handle('shell:open', (_e, url) => {
  if (isHttpUrl(url)) shell.openExternal(url);
});

// ───────────────────────────── жизненный цикл ─────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      credits: 'Пары на завтра для группы ТОГУ: время, аудитория, числитель/знаменатель.\nДанные — togudv.ru/rasp',
    });
    const theme = readJSON('settings.json', {}).theme;
    nativeTheme.themeSource = theme === 'light' ? 'light' : theme === 'system' ? 'system' : 'dark';
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
