const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['download:progress', 'transfer:queue', 'transfer:status', 'sync:status', 'sync:jobs', 'mail:mailto', 'drive:progress', 'update:progress', 'mail:new', 'login:waiting'];

contextBridge.exposeInMainWorld('hub', {
  call: async (channel, ...args) => {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on: (event, cb) => {
    if (!EVENTS.includes(event)) return () => {};
    const h = (e, payload) => cb(payload);
    ipcRenderer.on(event, h);
    return () => ipcRenderer.removeListener(event, h);
  },
});
