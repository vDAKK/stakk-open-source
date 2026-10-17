'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onEditMode:   (cb) => ipcRenderer.on('edit-mode',   (_e, value) => cb(value)),
  onFilterMode: (cb) => ipcRenderer.on('filter-mode', (_e, value) => cb(value)),
  onRadius:     (cb) => ipcRenderer.on('set-radius',  (_e, value) => cb(value)),
  toggleEdit:   () => ipcRenderer.send('toggle-edit'),
});
