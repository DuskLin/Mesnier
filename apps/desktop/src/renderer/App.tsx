import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronRight, CircleAlert, ClipboardList, Folder, FolderOpen, LayoutGrid, LoaderCircle, MessageSquare, Moon, PanelLeftOpen, PanelRight, Pencil, ShieldCheck, Sun, X } from 'lucide-react';
import type { Approval, Artifact, Project, Run, Session, Snapshot, Task } from '@mesnier/shared';
import logo from '../../../../assets/brand/mesnier-logo.png';
import { Board, Inspector } from './components/Board';
import { Chat } from './components/Chat';
import { AcceptDialog, ArtifactDialog, ProjectDialog, TaskDialog } from './components/Dialogs';
import { Settings } from './components/Settings';
import { Button, IconButton, Modal, readableError } from './components/ui';
import { isActive, latestRun } from './model';
import { Sidebar } from './components/Sidebar';
import { useNavigationHistory, type WorkbenchLocation } from './navigation';

type Dialog = { kind: 'project' } | { kind: 'settings' } | { kind: 'task'; session?: Session; task?: Task } | { kind: 'accept'; task: Task } | { kind: 'artifact'; artifact: Artifact } | { kind: 'retry'; run: Run } | { kind: 'rename'; session: Session } | { kind: 'project-detail'; project: Project };
type Notice = { kind: 'error' | 'success'; text: string };

function readPreference(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function savePreference(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* 受限环境仍可使用本次会话。 */ } }

export function App() {
  const bridge = window.mesnier;
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [loadError, setLoadError] = useState('');
  const [projectId, setProjectId] = useState<string>(() => readPreference('mesnier.project') ?? '');
  const [sessionId, setSessionId] = useState<string>(() => readPreference('mesnier.session') ?? '');
  const [view, setView] = useState<'chat' | 'board'>('chat');
  const [inspector, setInspector] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readPreference('mesnier.sidebar-collapsed') === 'true');
  const [compactWorkspace, setCompactWorkspace] = useState(false);
  const contentArea = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedModelId, setSelectedModelId] = useState<string>();
  const [theme, updateTheme] = useState<'light' | 'dark'>(() => readPreference('mesnier.theme') === 'dark' ? 'dark' : 'light');
  const [dialog, setDialog] = useState<Dialog>();
  const [notice, setNotice] = useState<Notice>();
  const locks = useRef(new Set<string>());
  const requestedSelection = useRef<{ projectId?: string; sessionId?: string }>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [rename, setRename] = useState('');

  useEffect(() => { document.documentElement.dataset.theme = theme; savePreference('mesnier.theme', theme); }, [theme]);
  useEffect(() => {
    if (!bridge) return;
    let current = true;
    const receive = (value: Snapshot) => { if (current) { setSnapshot((previous) => !previous || value.revision >= previous.revision ? value : previous); setLoadError(''); } };
    const unsubscribe = bridge.onChange(receive);
    void bridge.getSnapshot().then(receive).catch((error) => { if (current) setLoadError(readableError(error)); });
    return () => { current = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    if (!snapshot) return;
    // 命令返回和状态推送可能先后到达，不能提前回退刚创建的选择。
    const requested = requestedSelection.current;
    if (requested.projectId && !snapshot.projects.some((project) => project.id === requested.projectId)) return;
    if (requested.sessionId && !snapshot.sessions.some((session) => session.id === requested.sessionId)) return;
    requestedSelection.current = {};
    if (!snapshot.projects.some((project) => project.id === projectId)) setProjectId(snapshot.projects[0]?.id ?? '');
    if (!snapshot.sessions.some((session) => session.id === sessionId && session.projectId === projectId)) {
      setSessionId(snapshot.sessions.filter((session) => session.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? '');
    }
    if (!snapshot.models.some((model) => model.id === selectedModelId)) setSelectedModelId(snapshot.defaultModelId ?? snapshot.models[0]?.id);
  }, [snapshot, projectId, sessionId, selectedModelId]);
  useEffect(() => { if (projectId) savePreference('mesnier.project', projectId); }, [projectId]);
  useEffect(() => { if (sessionId) savePreference('mesnier.session', sessionId); }, [sessionId]);
  useEffect(() => { if (snapshot?.defaultModelId) setSelectedModelId(snapshot.defaultModelId); }, [snapshot?.defaultModelId]);
  useEffect(() => { if (notice?.kind !== 'success') return; const timer = setTimeout(() => setNotice(undefined), 4500); return () => clearTimeout(timer); }, [notice]);

  // 按工作区实际宽度保护对话，不用整窗宽度猜测面板是否放得下。
  useEffect(() => {
    const area = contentArea.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => setCompactWorkspace(entry.contentRect.width < 800));
    observer.observe(area);
    return () => observer.disconnect();
  }, [!!snapshot]);

  const command = useCallback(async <T,>(key: string, work: () => Promise<T>): Promise<T | undefined> => {
    if (locks.current.has(key)) return undefined;
    locks.current.add(key); setPending(new Set(locks.current));
    try { return await work(); } catch (error) { setNotice({ kind: 'error', text: readableError(error) }); return undefined; }
    finally { locks.current.delete(key); setPending(new Set(locks.current)); }
  }, []);
  const busy = (key: string) => pending.has(key);
  const newSession = useCallback(async () => {
    if (!bridge) return;
    if (!projectId) { setDialog({ kind: 'project' }); return; }
    const session = await command('new-session', () => bridge.createSession({ projectId }));
    if (session) { requestedSelection.current = { sessionId: session.id }; setSessionId(session.id); setView('chat'); setInspector(false); }
  }, [bridge, command, projectId]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !dialog) { event.preventDefault(); void newSession(); }
      if ((event.metaKey || event.ctrlKey) && event.key === ',' && !dialog) { event.preventDefault(); setDialog({ kind: 'settings' }); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [newSession, dialog]);

  const validLocation = (entry: WorkbenchLocation) => !!snapshot?.projects.some((item) => item.id === entry.projectId) && (entry.sessionId ? !!snapshot?.sessions.some((item) => item.id === entry.sessionId && item.projectId === entry.projectId) : !snapshot?.sessions.some((item) => item.projectId === entry.projectId));
  const currentLocation = { projectId, sessionId, view };
  const navigation = useNavigationHistory(validLocation(currentLocation) ? currentLocation : undefined, validLocation, (entry) => {
    setProjectId(entry.projectId); setSessionId(entry.sessionId); setView(entry.view); setInspector(false);
  });
  useEffect(() => {
    savePreference('mesnier.sidebar-collapsed', String(sidebarCollapsed));
    document.querySelector<HTMLButtonElement>(sidebarCollapsed ? '[aria-label="展开侧栏"]' : '[aria-label="收起侧栏"]')?.focus();
  }, [sidebarCollapsed]);

  if (!bridge) return <main className="fatal-state"><img src={logo} alt="Mesnier" width={58} /><h1>打开你的 Mesnier 工作台</h1><p>当前页面未连接桌面应用。请从 Mesnier 应用打开工作台，以访问本地项目、会话与内置 Agent。</p><Button onClick={() => location.reload()}>重新检查连接</Button></main>;
  if (!snapshot) return loadError ? <main className="fatal-state"><h1>暂时无法读取工作空间</h1><p>{loadError}</p><Button onClick={() => location.reload()}>重新载入</Button></main> : <div className="loading-state"><img src={logo} alt="Mesnier" /><LoaderCircle size={20} className="spin" /><p>正在准备你的工作空间…</p></div>;

  const project = snapshot.projects.find((item) => item.id === projectId);
  const session = snapshot.sessions.find((item) => item.id === sessionId && item.projectId === projectId);
  const task = snapshot.tasks.find((item) => item.sessionId === session?.id);
  const openChat = (id: string) => { const target = snapshot.sessions.find((item) => item.id === id); if (target) { setProjectId(target.projectId); setSessionId(id); setView('chat'); if (compactWorkspace) setInspector(false); } };
  const respond = (approval: Approval, decision: 'approved' | 'rejected') => { void command(`approval:${approval.requestId}`, () => bridge.respondApproval({ runId: approval.runId, requestId: approval.requestId, decision })); };
  const stop = (run: Run) => { void command(`stop:${run.id}`, async () => { await bridge.cancelRun(run.id); setNotice({ kind: 'success', text: '已提交停止请求，既有文件改动会保留。' }); }); };
  const send = async () => {
    if (!session) return;
    const text = drafts[session.id]?.trim(); if (!text) return;
    const run = await command(`send:${session.id}`, () => bridge.sendMessage({ sessionId: session.id, text, requestId: crypto.randomUUID(), modelId: selectedModelId }));
    if (run) setDrafts((previous) => ({ ...previous, [session.id]: previous[session.id]?.trim() === text ? '' : previous[session.id] ?? '' }));
  };
  const start = (target: Task) => {
    const previous = latestRun(snapshot.runs, target.sessionId);
    if (previous && ['failed', 'cancelled', 'interrupted'].includes(previous.status)) { setDialog({ kind: 'retry', run: previous }); return; }
    void command(`start:${target.id}`, () => bridge.enqueueTask({ taskId: target.id, requestId: crypto.randomUUID(), modelId: selectedModelId }));
  };
  const openExternal = (url: string) => { void command(`open:${url}`, () => bridge.openExternal(url)); };
  const newTask = () => { if (!project) setDialog({ kind: 'project' }); else setDialog({ kind: 'task' }); };

  return <div className={`shell ${snapshot.app.platform === 'darwin' ? 'mac' : ''} ${inspector && compactWorkspace ? 'inspector-overlay' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <Sidebar snapshot={snapshot} projectId={projectId} sessionId={sessionId} view={view} newSessionBusy={busy('new-session')} canBack={navigation.canBack} canForward={navigation.canForward} onBack={navigation.back} onForward={navigation.forward} onCollapse={() => setSidebarCollapsed(true)} onProject={(id) => { setProjectId(id); setInspector(false); }} onSession={openChat} onNewTask={newTask} onNewSession={() => void newSession()} onBoard={() => { setView('board'); setInspector(false); }} onAddProject={() => setDialog({ kind: 'project' })} onSettings={() => setDialog({ kind: 'settings' })} />
    <main className="workspace">
      <header className="topbar">{sidebarCollapsed && <IconButton label="展开侧栏" onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen size={16} /></IconButton>}<div className="breadcrumbs"><Folder size={14} /><strong title={project?.path}>{project?.name ?? '你的工作空间'}</strong>{project && <><ChevronRight size={12} /><span>{view === 'chat' ? '对话' : '看板'}</span></>}</div><div className="topbar-spacer" />
        <div className="segmented" aria-label="工作视图"><button type="button" className={view === 'chat' ? 'selected' : ''} aria-pressed={view === 'chat'} onClick={() => setView('chat')}><MessageSquare size={14} />对话</button><button type="button" className={view === 'board' ? 'selected' : ''} aria-pressed={view === 'board'} onClick={() => setView('board')}><LayoutGrid size={14} />看板</button></div>
        <IconButton label={theme === 'light' ? '切换深色外观' : '切换浅色外观'} onClick={() => updateTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</IconButton>
        {project && <IconButton label="项目目录与设置" onClick={() => setDialog({ kind: 'project-detail', project })}><FolderOpen size={16} /></IconButton>}
        <IconButton label="切换产物与记录面板" className={inspector ? 'active' : ''} onClick={() => setInspector(!inspector)}><PanelRight size={16} /></IconButton>
      </header>
      <div className="content-area" ref={contentArea}>{inspector && compactWorkspace && <button type="button" className="inspector-scrim" aria-label="关闭详情遮罩" tabIndex={-1} onClick={() => setInspector(false)} />}<div className="main-pane" inert={inspector && compactWorkspace}>
        {!project || (view === 'chat' && !session) ? <div className="welcome"><div className="welcome-inner"><img className="welcome-logo" src={logo} alt="Mesnier" /><div className="eyebrow">你的下一份工作，从这里开始</div><h1>在对话中探索，<br /><em>在看板中推进。</em></h1><p className="welcome-description">让想法拥有一个工作空间。与 Agent 一起思考、创作和编程，把每一次探索，变成看得见的成果。</p>
          <div className="welcome-cards"><button type="button" className="welcome-card" onClick={() => void newSession()}><div className="card-icon"><MessageSquare size={20} /></div><ArrowRight className="arrow" size={17} /><h3>从一段对话开始</h3><p>讨论一个想法，分析资料，<br />或一起解决手头的问题。</p></button><button type="button" className="welcome-card" onClick={() => { setView('board'); if (!project) setDialog({ kind: 'project' }); else newTask(); }}><div className="card-icon"><LayoutGrid size={20} /></div><ArrowRight className="arrow" size={17} /><h3>让任务持续推进</h3><p>明确目标，交给 Agent 执行，<br />在看板中跟进与验收。</p></button></div>
          <div className="onboarding-steps"><button type="button" className={`button ghost small onboarding-step ${snapshot.models.length ? 'done' : ''}`} onClick={() => setDialog({ kind: 'settings' })}><span className="step-number">{snapshot.models.length ? <Check size={11} /> : '1'}</span>配置模型</button><button type="button" className={`button ghost small onboarding-step ${project ? 'done' : ''}`} onClick={() => setDialog({ kind: 'project' })}><span className="step-number">{project ? <Check size={11} /> : '2'}</span>选择工作目录</button><span className="onboarding-step"><span className="step-number">3</span>开始创造</span></div><p className="welcome-note"><ShieldCheck size={12} />工作记录保存在本机 · 文件修改与命令执行需批准</p>
        </div></div> : view === 'board' ? <Board snapshot={snapshot} projectId={project.id} selectedTaskId={inspector ? task?.id : undefined} onSelect={(target) => { setSessionId(target.sessionId); setInspector(true); }} onCreate={newTask} /> : session && <>
          <div className="view-heading"><div><h1 className="view-title" title={session.title}>{session.title}</h1><p>{task ? `关联任务 · ${task.title}` : '把当前想法与接下来的行动连接起来。'}</p></div><div className="actions"><IconButton label="重命名会话" onClick={() => { setRename(session.title); setDialog({ kind: 'rename', session }); }}><Pencil size={14} /></IconButton><Button className="small" onClick={() => { if (task) { setView('board'); setInspector(true); } else setDialog({ kind: 'task', session }); }}><ClipboardList size={14} />{task ? '查看任务' : '加入看板'}</Button></div></div>
          <Chat snapshot={snapshot} session={session} draft={drafts[session.id] ?? ''} setDraft={(text) => setDrafts((previous) => ({ ...previous, [session.id]: text }))} selectedModelId={selectedModelId} onSelectModel={setSelectedModelId} onSend={() => void send()} onStop={stop} onSettings={() => setDialog({ kind: 'settings' })} onRespond={respond} onRetry={(run) => setDialog({ kind: 'retry', run })} onOpenLink={openExternal} busy={busy} />
        </>}
      </div>{inspector && <Inspector overlay={compactWorkspace} snapshot={snapshot} sessionId={session?.id} task={task} model={snapshot.models.find((item) => item.id === selectedModelId)} onClose={() => setInspector(false)} onOpenChat={openChat} onEditTask={(target) => setDialog({ kind: 'task', task: target })} onStart={start} onAccept={(target) => setDialog({ kind: 'accept', task: target })} onStop={stop} onRespond={respond} onArtifact={(artifact) => setDialog({ kind: 'artifact', artifact })} busy={busy} />}</div>
    </main>
    {dialog?.kind === 'project' && <ProjectDialog bridge={bridge} onClose={() => setDialog(undefined)} onCreated={(created) => { requestedSelection.current = { projectId: created.id }; setProjectId(created.id); setSessionId(''); setDialog(undefined); setNotice({ kind: 'success', text: `已添加项目「${created.name}」。` }); }} />}
    {dialog?.kind === 'settings' && <Settings snapshot={snapshot} bridge={bridge} theme={theme} setTheme={updateTheme} onClose={() => setDialog(undefined)} />}
    {dialog?.kind === 'task' && project && <TaskDialog snapshot={snapshot} bridge={bridge} projectId={project.id} session={dialog.session} task={dialog.task} onClose={() => setDialog(undefined)} onSaved={(created) => { requestedSelection.current = { sessionId: created.sessionId }; setSessionId(created.sessionId); setView('board'); setInspector(true); setDialog(undefined); }} />}
    {dialog?.kind === 'accept' && <AcceptDialog task={dialog.task} bridge={bridge} onClose={() => setDialog(undefined)} onAccepted={() => { setDialog(undefined); setNotice({ kind: 'success', text: '验收已记录，任务已完成。' }); }} />}
    {dialog?.kind === 'artifact' && <ArtifactDialog artifact={dialog.artifact} bridge={bridge} onClose={() => setDialog(undefined)} />}
    {dialog?.kind === 'retry' && <Modal title="重试这次执行" description="将沿用当前会话和工作目录，以本次选择的模型创建一条新执行。原执行的错误、事件与产物会保留。" onClose={() => { if (!busy(`retry:${dialog.run.id}`)) setDialog(undefined); }}><div className="inline-notice"><CircleAlert size={16} /><span>已发生的文件改动不会自动回滚，重试可能再次执行相关操作。</span></div><div className="modal-actions"><Button disabled={busy(`retry:${dialog.run.id}`)} onClick={() => setDialog(undefined)}>取消</Button><Button variant="primary" busy={busy(`retry:${dialog.run.id}`)} onClick={() => { const run = dialog.run; void command(`retry:${run.id}`, async () => { await bridge.sendMessage({ sessionId: run.sessionId, text: run.prompt, requestId: crypto.randomUUID(), modelId: selectedModelId, agentId: run.agent.id, retryOf: run.id }); setDialog(undefined); }); }}>确认重试</Button></div></Modal>}
    {dialog?.kind === 'rename' && <Modal title="重命名会话" onClose={() => { if (!busy(`rename:${dialog.session.id}`)) setDialog(undefined); }}><form onSubmit={(event) => { event.preventDefault(); const target = dialog.session; if (rename.trim()) void command(`rename:${target.id}`, async () => { await bridge.renameSession({ sessionId: target.id, title: rename.trim() }); setDialog(undefined); }); }}><label className="field"><span>会话标题</span><input value={rename} onChange={(event) => setRename(event.target.value)} maxLength={200} required /></label><div className="modal-actions"><Button disabled={busy(`rename:${dialog.session.id}`)} onClick={() => setDialog(undefined)}>取消</Button><Button type="submit" variant="primary" busy={busy(`rename:${dialog.session.id}`)} disabled={!rename.trim()}>保存</Button></div></form></Modal>}
    {dialog?.kind === 'project-detail' && <Modal title={dialog.project.name} description="工作目录与项目记录" onClose={() => setDialog(undefined)}><p className="artifact-path mono">{dialog.project.path}</p><div className="inline-notice"><Folder size={16} /><span>{snapshot.sessions.filter((item) => item.projectId === dialog.project.id).length} 个会话 · {snapshot.tasks.filter((item) => item.projectId === dialog.project.id).length} 项任务</span></div><p className="settings-meta">有会话历史的项目保留记录，不能直接移除。移除空项目不会删除本地文件。</p><div className="modal-actions"><Button disabled={snapshot.sessions.some((item) => item.projectId === dialog.project.id)} onClick={() => { const id = dialog.project.id; void command(`remove-project:${id}`, async () => { await bridge.removeProject(id); setDialog(undefined); }); }}>移除空项目</Button><Button variant="primary" onClick={() => void command(`reveal:${dialog.project.id}`, () => bridge.revealProject(dialog.project.id))}><FolderOpen size={15} />打开工作目录</Button></div></Modal>}
    {notice && <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <CircleAlert size={17} /> : <Check size={17} />}<span>{notice.text}</span><IconButton label="关闭提示" onClick={() => setNotice(undefined)}><X size={15} /></IconButton></div>}
  </div>;
}
