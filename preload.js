'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  onUsage: (cb) => ipcRenderer.on('usage', (_e, data) => cb(data)),
  menu: () => ipcRenderer.send('menu'),
  refresh: () => ipcRenderer.send('refresh'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
});
