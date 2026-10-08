// electron 替身：仅提供 getPath（指向真实 userData），供 SettingsStore 使用
module.exports = {
  app: {
    // electron-vite dev 下 app.getName() 为 Electron，真实 settings.json 在此
    getPath: () => 'C:/Users/蒋奎/AppData/Roaming/Electron',
    isPackaged: true,
    whenReady: () => Promise.resolve()
  },
  ipcMain: { handle: () => {} },
  dialog: {},
  shell: {}
}
