const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('medilogix', {
  choosePort: (portId) => ipcRenderer.invoke('serial:choose-port', portId),
  startSession: (options) => ipcRenderer.invoke('session:start', options),
  appendRecord: (record) => ipcRenderer.invoke('session:append', record),
  endSession: (status) => ipcRenderer.invoke('session:end', status),
  startDemo: (options) => ipcRenderer.invoke('demo:start', options),
  stopDemo: () => ipcRenderer.invoke('demo:stop'),
  listSessions: () => ipcRenderer.invoke('session:list'),
  getSessionRecords: (sessionId) => ipcRenderer.invoke('session:get-records', sessionId),
  exportSession: (sessionId) => ipcRenderer.invoke('session:export', sessionId),
  showSessionFolder: (sessionId) => ipcRenderer.invoke('session:show-folder', sessionId),
  showRecordingsRoot: () => ipcRenderer.invoke('session:show-root'),
  recordingsPath: () => ipcRenderer.invoke('app:recordings-path'),
  onRecord: (callback) => ipcRenderer.on('serial:record', (_event, value) => callback(value)),
  onAvailablePorts: (callback) => ipcRenderer.on('serial:ports', (_event, value) => callback(value)),
  onSerialState: (callback) => ipcRenderer.on('serial:state', (_event, value) => callback(value)),
  onSessionStatus: (callback) => ipcRenderer.on('session:status', (_event, value) => callback(value)),
  onNotice: (callback) => ipcRenderer.on('app:notice', (_event, value) => callback(value))
});
