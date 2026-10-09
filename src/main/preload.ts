import { contextBridge, ipcRenderer } from 'electron';
import type { StudioBridge } from '../shared/contracts';
const bridge: StudioBridge = {
  invoke: (command, args) => ipcRenderer.invoke('studio:invoke', command, args),
  on: (event, listener) => {
    if (!['queue', 'log', 'connections'].includes(event)) throw new Error('Onbekende gebeurtenis.');
    const channel = `studio:${event}`;
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on(channel, handler); return () => { ipcRenderer.removeListener(channel, handler); };
  },
};
contextBridge.exposeInMainWorld('ftp', bridge);
