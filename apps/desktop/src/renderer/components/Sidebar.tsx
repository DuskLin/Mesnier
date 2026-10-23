import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, FolderOpen, LayoutGrid, ListFilter, MessageCirclePlus, MessageSquare, PanelLeftClose, Plus, Search, Settings2, X } from 'lucide-react';
import type { Session, Snapshot } from '@mesnier/shared';
import logo from '../../../../../assets/brand/mesnier-logo.png';
import { isActive, latestRun, runLabels } from '../model';
import { IconButton } from './ui';

function relativeTime(value: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时`;
  return `${Math.floor(minutes / 1440)}天`;
}

export function Sidebar({ snapshot, projectId, sessionId, view, newSessionBusy, canBack, canForward, onBack, onForward, onCollapse, onProject, onSession, onNewTask, onNewSession, onBoard, onAddProject, onSettings }: {
  snapshot: Snapshot; projectId: string; sessionId: string; view: 'chat' | 'board'; newSessionBusy: boolean;
  canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void; onCollapse: () => void;
  onProject: (id: string) => void; onSession: (id: string) => void; onNewTask: () => void; onNewSession: () => void;
  onBoard: () => void; onAddProject: () => void; onSettings: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [listView, setListView] = useState<'projects' | 'recent'>('projects');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (searchOpen) search.current?.focus(); }, [searchOpen]);
  useEffect(() => { setCollapsed((previous) => { if (!previous.has(projectId)) return previous; const next = new Set(previous); next.delete(projectId); return next; }); }, [projectId, sessionId]);
  const term = query.trim().toLocaleLowerCase();
  const sessions = snapshot.sessions.filter((item) => {
    const project = snapshot.projects.find((entry) => entry.id === item.projectId);
    return !term || `${item.title} ${project?.name ?? ''}`.toLocaleLowerCase().includes(term);
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const projects = snapshot.projects.filter((item) => !term || item.name.toLocaleLowerCase().includes(term) || sessions.some((session) => session.projectId === item.id));
  const limited = (items: Session[], key: string) => {
    if (term) return items;
    const visible = items.slice(0, limits[key] ?? 6);
    const selected = items.find((item) => item.id === sessionId);
    return selected && !visible.includes(selected) ? [...visible, selected] : visible;
  };
  const row = (session: Session) => {
    const run = latestRun(snapshot.runs, session.id);
    const status = run && (isActive(run) || ['failed', 'interrupted'].includes(run.status)) ? run.status : undefined;
    return <button type="button" key={session.id} data-session-id={session.id} aria-label={session.title} aria-current={sessionId === session.id && view === 'chat' ? 'page' : undefined} className={`sidebar-session ${sessionId === session.id && view === 'chat' ? 'selected' : ''}`} title={status ? `${session.title} · ${runLabels[status]}` : session.title} onClick={() => onSession(session.id)}>
      {status && <span className={`status-dot ${status}`} aria-hidden="true" />}
      <span className="sidebar-session-title">{session.title}</span><time dateTime={session.updatedAt} title={new Date(session.updatedAt).toLocaleString('zh-CN')} aria-hidden="true">{relativeTime(session.updatedAt, now)}</time>
    </button>;
  };
  const more = (items: Session[], key: string) => !term && items.length > limited(items, key).length && <button type="button" className="sidebar-more" aria-label={`显示更多${key === 'recent' ? '任务' : '项目会话'}`} onClick={() => setLimits((previous) => ({ ...previous, [key]: (previous[key] ?? 6) + 12 }))}>显示更多</button>;
  const active = snapshot.runs.filter(isActive).length;
  const runtimeStatus = snapshot.runtime.ready ? active ? `${active} 项工作正在执行或排队` : '内置 Agent 已就绪' : '运行时需要检查';
  return <aside className="sidebar" aria-label="项目与会话导航">
    <div className="sidebar-tools"><IconButton label="收起侧栏" onClick={onCollapse}><PanelLeftClose size={16} /></IconButton><IconButton label="后退" disabled={!canBack} onClick={onBack}><ArrowLeft size={16} /></IconButton><IconButton label="前进" disabled={!canForward} onClick={onForward}><ArrowRight size={16} /></IconButton></div>
    <nav className="sidebar-primary" aria-label="工作入口">
      <button type="button" onClick={onNewTask}><MessageCirclePlus size={16} /><span>新建任务</span></button>
      <button type="button" disabled={newSessionBusy} onClick={onNewSession}><MessageSquare size={16} /><span>新建对话</span><kbd>{snapshot.app.platform === 'darwin' ? '⌘ N' : 'Ctrl N'}</kbd></button>
      <button type="button" onClick={onBoard} aria-pressed={view === 'board'}><LayoutGrid size={16} /><span>任务看板</span></button>
    </nav>
    <div className="sidebar-list-heading"><span>任务列表</span><IconButton label="搜索任务列表" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setQuery(''); }}><Search size={15} /></IconButton><IconButton label={listView === 'projects' ? '按最近更新显示' : '按项目显示'} onClick={() => setListView(listView === 'projects' ? 'recent' : 'projects')}><ListFilter size={15} /></IconButton></div>
    {searchOpen && <div className="sidebar-search"><input ref={search} aria-label="搜索会话与项目" placeholder="搜索任务或项目…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }} /><IconButton label="清除搜索" onClick={() => { setQuery(''); search.current?.focus(); }}><X size={14} /></IconButton></div>}
    <div className="sidebar-list">
      <div className="sidebar-section-label"><span>{listView === 'projects' ? '项目' : '最近更新'}</span><IconButton label="添加项目" onClick={onAddProject}><Plus size={14} /></IconButton></div>
      {listView === 'projects' ? projects.map((project) => {
        const items = sessions.filter((session) => session.projectId === project.id);
        const expanded = !!term || !collapsed.has(project.id);
        return <section key={project.id} className="sidebar-project" data-project-id={project.id}>
          <button type="button" className="sidebar-project-heading" aria-label={project.name} title={project.path} aria-expanded={expanded} onClick={() => { onProject(project.id); setCollapsed((previous) => { const next = new Set(previous); if (expanded && projectId === project.id) next.add(project.id); else next.delete(project.id); return next; }); }}><FolderOpen size={16} /><span>{project.name}</span><ChevronDown size={12} className={expanded ? '' : 'closed'} /></button>
          {expanded && <div className="sidebar-project-items">{limited(items, project.id).map(row)}{more(items, project.id)}{!items.length && <p className="sidebar-list-empty">尚无会话</p>}</div>}
        </section>;
      }) : <div className="sidebar-recent">{limited(sessions, 'recent').map(row)}{more(sessions, 'recent')}</div>}
      {!snapshot.projects.length && <button type="button" className="sidebar-add-project" onClick={onAddProject}><FolderOpen size={16} />添加工作目录</button>}
      {!!term && !sessions.length && !projects.length && <p className="sidebar-empty">没有匹配的任务或项目</p>}
      {listView === 'recent' && !sessions.length && <p className="sidebar-empty">{term ? '没有匹配的任务' : '尚无会话'}</p>}
    </div>
    <div className="sidebar-footer"><img src={logo} alt="" /><strong>Mesnier</strong><span className={`status-dot ${snapshot.runtime.ready ? 'ready' : 'unavailable'}`} title={runtimeStatus} role="img" aria-label={runtimeStatus} /><IconButton label="设置与模型" onClick={onSettings}><Settings2 size={16} /></IconButton></div>
  </aside>;
}
