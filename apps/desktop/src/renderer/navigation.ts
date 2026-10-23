import { useEffect, useRef, useState } from 'react';

export interface WorkbenchLocation { projectId: string; sessionId: string; view: 'chat' | 'board' }
const keyOf = (location: WorkbenchLocation) => JSON.stringify([location.projectId, location.sessionId, location.view]);

/** 页面历史仅保存身份，不触发宿主命令；过滤、草稿和执行状态不属于导航副本。 */
export function useNavigationHistory(location: WorkbenchLocation | undefined, valid: (entry: WorkbenchLocation) => boolean, restore: (entry: WorkbenchLocation) => void) {
  const [history, setHistory] = useState<{ entries: WorkbenchLocation[]; index: number }>({ entries: [], index: -1 });
  const pending = useRef<string | undefined>(undefined);
  const key = location ? keyOf(location) : '';
  useEffect(() => {
    if (!location) return;
    if (pending.current) { if (pending.current === key) pending.current = undefined; return; }
    setHistory((previous) => {
      if (previous.index >= 0 && keyOf(previous.entries[previous.index]) === key) return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), location].slice(-100);
      return { entries, index: entries.length - 1 };
    });
  }, [key]);
  const nextIndex = (step: number) => {
    for (let index = history.index + step; index >= 0 && index < history.entries.length; index += step) if (valid(history.entries[index])) return index;
    return -1;
  };
  const go = (step: number) => {
    const index = nextIndex(step); if (index < 0) return;
    const entry = history.entries[index]; pending.current = keyOf(entry);
    setHistory((previous) => ({ ...previous, index })); restore(entry);
  };
  return { canBack: nextIndex(-1) >= 0, canForward: nextIndex(1) >= 0, back: () => go(-1), forward: () => go(1) };
}
