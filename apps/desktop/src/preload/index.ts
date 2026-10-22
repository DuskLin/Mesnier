import { contextBridge, ipcRenderer } from 'electron';
import type { MesnierBridge, Snapshot } from '@mesnier/shared';

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`mesnier:${method}`, ...args);
const bridge: MesnierBridge = {
  getSnapshot: () => invoke('getSnapshot'),
  onChange(callback) {
    const listener = (_event: unknown, snapshot: Snapshot) => callback(snapshot);
    ipcRenderer.on('mesnier:snapshot', listener);
    return () => ipcRenderer.removeListener('mesnier:snapshot', listener);
  },
  selectDirectory: () => invoke('selectDirectory'),
  createProject: input => invoke('createProject', input),
  removeProject: id => invoke('removeProject', id),
  createSession: input => invoke('createSession', input),
  renameSession: input => invoke('renameSession', input),
  sendMessage: input => invoke('sendMessage', input),
  cancelRun: id => invoke('cancelRun', id),
  respondApproval: input => invoke('respondApproval', input),
  createTask: input => invoke('createTask', input),
  updateTask: input => invoke('updateTask', input),
  enqueueTask: input => invoke('enqueueTask', input),
  acceptTask: input => invoke('acceptTask', input),
  saveModelConfig: input => invoke('saveModelConfig', input),
  testModel: id => invoke('testModel', id),
  setDefaultModel: id => invoke('setDefaultModel', id),
  deleteModel: id => invoke('deleteModel', id),
  readArtifact: id => invoke('readArtifact', id),
  openArtifact: id => invoke('openArtifact', id),
  revealProject: id => invoke('revealProject', id),
  openExternal: url => invoke('openExternal', url),
  copyText: text => invoke('copyText', text)
};
contextBridge.exposeInMainWorld('mesnier', bridge);
