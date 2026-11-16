const { app, BrowserWindow, Menu, shell, ipcMain, net } = require('electron');
const path = require('path');

// Blueprint data comes from the Star Citizen Wiki API (api.star-citizen.wiki).
// It is fetched here in the main process so the page does not depend on CORS.
// SCCS_WIKI_BASE is only for local testing against a mock server.
const WIKI_BASE = process.env.SCCS_WIKI_BASE || 'https://api.star-citizen.wiki/api/';

ipcMain.handle('wiki:get', async (_e, endpoint) => {
  if (typeof endpoint !== 'string' || !/^(blueprints|missions)[\w\-/?=&%[\].,]*$/.test(endpoint)) throw new Error('Bad endpoint');
  const res = await net.fetch(WIKI_BASE + endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'SC-Cargo-Sales/1.1' }
  });
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
  return res.json();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 500,
    backgroundColor: '#0b0f17',
    title: "Sanbon's SC Tools",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // Open external links (e.g. uexcorp.space) in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
