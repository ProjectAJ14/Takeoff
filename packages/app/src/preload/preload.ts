// Sandboxed preload: the renderer's only bridge to the main process. It exposes the API address and session
// token, native pickers, provider approvals, reveal-in-folder, and dropped-file paths. No Node, no raw ipcRenderer.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

type Pool = 'takes' | 'broll';
const config = ipcRenderer.sendSync('takeoff:config') as { apiBase: string; token: string } | null;
const pool = (kind: unknown): Pool => {
  if (kind !== 'takes' && kind !== 'broll') throw new Error('kind must be takes or broll');
  return kind;
};

contextBridge.exposeInMainWorld('takeoff', {
  apiBase: config?.apiBase ?? '',
  token: config?.token ?? '',
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('takeoff:pick-folder'),
  pickFiles: (kind: Pool): Promise<string[]> => ipcRenderer.invoke('takeoff:pick-files', pool(kind)),
  /** Paths of files the user dropped; only real File objects from a drop have one. */
  dropFiles: (files: File[], kind: Pool): Promise<string[]> =>
    ipcRenderer.invoke('takeoff:dropped-files', Array.from(files, (f) => webUtils.getPathForFile(f)).filter(Boolean), pool(kind)),
  /** Saves a project's provider approvals through main (not writable over the HTTP API). */
  setProviders: (projectId: string, policy: unknown): Promise<{ policy?: unknown; error?: unknown }> => ipcRenderer.invoke('takeoff:set-providers', String(projectId), policy),
  revealInFolder: (path?: string): Promise<boolean> => ipcRenderer.invoke('takeoff:reveal', typeof path === 'string' ? path : undefined),
});
