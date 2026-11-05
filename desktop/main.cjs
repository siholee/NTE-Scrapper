const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
if (process.env.NTE_TEST_USER_DATA) app.setPath('userData', process.env.NTE_TEST_USER_DATA);
process.env.NTE_DATA_DIR ||= path.join(app.getPath('userData'), 'data');
const moduleUrl = name => pathToFileURL(path.join(__dirname, '..', 'src', name)).href;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let win;
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    const { rpc } = await import(moduleUrl('bridge.js'));
    const operations = { start: args => rpc('start', { url: String(args.url || ''), delayMs: 7000 }), status: () => rpc('status'), resume: args => rpc('continue', { jobId: args.jobId }), cancel: args => rpc('cancel', { jobId: args.jobId }) };
    for (const [name, operation] of Object.entries(operations)) ipcMain.handle('nte:' + name, async (event, args = {}) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid sender');
      try { return { ok: true, value: await operation(args) }; } catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('nte:folder', async event => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
      const fs = require('node:fs/promises'); const folder = path.join(process.env.NTE_DATA_DIR, 'library');
      await fs.mkdir(folder, { recursive: true }); return shell.openPath(folder);
    });
    win = new BrowserWindow({ width: 650, height: 560, minWidth: 540, minHeight: 440, title: 'NTE Scrapper', autoHideMenuBar: true, backgroundColor: '#f5f7fa', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    await win.loadFile(path.join(__dirname, 'index.html'));
  }).catch(error => { require('electron').dialog.showErrorBox('실행 오류', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
