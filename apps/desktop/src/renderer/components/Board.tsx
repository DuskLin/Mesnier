import { Bot, Columns3, Filter, SlidersHorizontal, CheckCheck, ClipboardList, FileText, FolderOpen, MessageSquare, Pencil, Play, Plus, Search, ShieldCheck, X } from 'lucide-react';
import type { Approval, Artifact, ModelConfig, Run, Snapshot, Task, TaskStatus } from '@mesnier/shared';
import { useEffect, useRef, useState } from 'react';
import { isActive, latestRun, taskLabels } from '../model';
import { ApprovalCard, StatusBadge } from './Chat';
import { Button, EmptyState, IconButton, shortDate } from './ui';

const columns: { id: TaskStatus; className: string; empty: string }[] = [
  { id: 'todo', className: 'todo', empty: '准备好下一件值得做的事' },
  { id: 'in_progress', className: 'running', empty: '开始执行后会显示在这里' },
  { id: 'review', className: 'review', empty: '完成执行的工作等待你的验收' },
  { id: 'done', className: 'done', empty: '已验收的成果会留在这里' },
];

export function Board({ snapshot, projectId, selectedTaskId, onSelect, onCreate }: { snapshot: Snapshot; projectId: string; selectedTaskId?: string; onSelect: (task: Task) => void; onCreate: () => void }) {
  const [search, setSearch] = useState('');
  const [agentId, setAgentId] = useState('');
  const [status, setStatus] = useState('');
  const [menu, setMenu] = useState<'filter' | 'display'>();
  const [display, setDisplay] = useState({ description: false, project: true, time: true });
  const [order, setOrder] = useState('newest');
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: MouseEvent) => { if (!toolbar.current?.contains(event.target as Node)) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(undefined); toolbar.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus(); } };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const all = snapshot.tasks.filter((task) => task.projectId === projectId);
  const tasks = all.filter((task) => (!agentId || task.agentId === agentId) && (!status || task.status === status) && `${task.title} ${task.description}`.toLowerCase().includes(search.toLowerCase()));
  const project = snapshot.projects.find((item) => item.id === projectId);
  const activeAgents = new Set(snapshot.runs.filter((run) => ['running', 'waiting_approval', 'cancelling'].includes(run.status) && all.some((task) => task.sessionId === run.sessionId)).map((run) => run.agent.id)).size;
  const relativeTime = (value: string) => { const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000)); return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes}分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)}小时前` : `${Math.floor(minutes / 1440)}天前`; };
  return <>
    <div className="board-heading"><h1>任务</h1><span className="board-total">{all.length}</span><Button className="small" variant="primary" onClick={onCreate}><Plus size={14} />新建任务</Button></div>
    <div className="board-toolbar" ref={toolbar}>
      <Button className="small board-all" variant="ghost" onClick={() => { setSearch(''); setAgentId(''); setStatus(''); }}><ClipboardList size={14} />全部任务</Button>
      <div className="search-field"><Search size={14} /><input aria-label="搜索任务" placeholder="搜索任务…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <span className="board-count"><span className={`status-dot ${activeAgents ? 'running' : ''}`} />{activeAgents} 个 Agent 活跃</span>
      <div className="board-menu-anchor"><Button className="small" variant="ghost" aria-expanded={menu === 'filter'} aria-controls="board-filter" onClick={() => setMenu(menu === 'filter' ? undefined : 'filter')}><Filter size={14} />筛选{(agentId || status) && <span className="filter-indicator" />}</Button>
        {menu === 'filter' && <div className="board-popover" id="board-filter" role="group" aria-label="任务筛选"><label>Agent<select aria-label="按 Agent 筛选" value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">全部 Agent</option>{snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label>状态<select aria-label="按任务状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{columns.map((column) => <option key={column.id} value={column.id}>{taskLabels[column.id]}</option>)}</select></label></div>}
      </div>
      <div className="board-menu-anchor"><Button className="small" variant="ghost" aria-expanded={menu === 'display'} aria-controls="board-display" onClick={() => setMenu(menu === 'display' ? undefined : 'display')}><SlidersHorizontal size={14} />显示</Button>
        {menu === 'display' && <div className="board-popover" id="board-display" role="group" aria-label="卡片显示"><strong>卡片信息</strong>{([{ key: 'description', label: '任务摘要' }, { key: 'project', label: '项目标签' }, { key: 'time', label: '更新时间' }] as const).map(({ key, label }) => <label className="board-check" key={key}><input type="checkbox" checked={display[key]} onChange={(event) => setDisplay((previous) => ({ ...previous, [key]: event.target.checked }))} />{label}</label>)}<label>排序<select aria-label="任务排序" value={order} onChange={(event) => setOrder(event.target.value)}><option value="newest">最近更新优先</option><option value="oldest">最早更新优先</option></select></label></div>}
      </div><span className="board-view-label"><Columns3 size={14} />看板</span>
    </div>
    <div className="board" aria-label="任务看板">
      {columns.filter((column) => !status || column.id === status).map((column) => <section key={column.id} className={`board-column ${column.className}`} aria-label={taskLabels[column.id]}>
        <div className="column-heading"><span className={`column-dot ${column.className}`} />{taskLabels[column.id]}<span className="count">{tasks.filter((task) => task.status === column.id).length}</span>{column.id === 'todo' && <IconButton label="新建待办任务" onClick={onCreate}><Plus size={14} /></IconButton>}</div>
        <div className="column-tasks">
        {tasks.filter((task) => task.status === column.id).sort((a, b) => order === 'newest' ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt.localeCompare(b.updatedAt)).map((task) => {
          const run = latestRun(snapshot.runs, task.sessionId);
          const agent = snapshot.agents.find((item) => item.id === task.agentId);
          const approvals = snapshot.approvals.filter((item) => item.runId === run?.id).length;
          return <button type="button" draggable={false} key={task.id} onClick={() => onSelect(task)} className={`task-card ${selectedTaskId === task.id ? 'selected' : ''}`} data-task-id={task.id}>
            <div className="task-card-top"><span className="mono">MN-{task.id.slice(-5).toUpperCase()}</span><ClipboardList size={12} /></div>
            <h3>{task.title}</h3>{display.description && task.description && <p>{task.description}</p>}
            {run && run.status !== 'succeeded' && <StatusBadge run={run} />}{approvals > 0 && <span className="status-badge waiting_approval"><ShieldCheck size={11} />{approvals} 项授权</span>}
            {display.project && <span className="task-project"><FolderOpen size={11} />{project?.name}</span>}
            <div className="task-card-footer"><span className="agent-avatar"><Bot size={12} /></span><span className="task-agent-name">{agent?.name ?? '默认 Agent'}</span>{display.time && <time dateTime={task.updatedAt} title={shortDate(task.updatedAt)}>{relativeTime(task.updatedAt)}</time>}</div>
          </button>;
        })}
        {!tasks.some((task) => task.status === column.id) && <div className="column-empty">{search || agentId ? '没有匹配的任务' : column.empty}</div>}
        </div>
      </section>)}
    </div>
  </>;
}

export function Inspector({ overlay = false, snapshot, sessionId, task, model, onClose, onOpenChat, onEditTask, onStart, onAccept, onStop, onRespond, onArtifact, busy }: {
  overlay?: boolean; snapshot: Snapshot; sessionId?: string; task?: Task; model?: ModelConfig; onClose: () => void; onOpenChat: (sessionId: string) => void;
  onEditTask: (task: Task) => void; onStart: (task: Task) => void; onAccept: (task: Task) => void; onStop: (run: Run) => void;
  onRespond: (approval: Approval, decision: 'approved' | 'rejected') => void; onArtifact: (artifact: Artifact) => void; busy: (key: string) => boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!overlay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!document.querySelector('[role="dialog"]')) panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        event.preventDefault(); close.current();
      }
    };
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('keydown', escape); if (previous?.isConnected) previous.focus(); };
  }, [overlay]);
  const runs = snapshot.runs.filter((run) => run.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const artifacts = snapshot.artifacts.filter((artifact) => artifact.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = runs.find(isActive);
  const current = runs[0];
  const approvals = snapshot.approvals.filter((approval) => runs.some((run) => run.id === approval.runId));
  return <aside ref={panel} className="inspector" aria-label={task ? '任务详情' : '产物与执行记录'}>
    <div className="inspector-heading"><h2>{task ? <ClipboardList size={15} /> : <FolderOpen size={15} />}{task ? '任务详情' : '产物与记录'}</h2><IconButton label="关闭详情面板" onClick={onClose}><X size={17} /></IconButton></div>
    <div className="inspector-content">
      {task && <><h3>{task.title}</h3><span className={`status-badge ${task.status}`}>{taskLabels[task.status]}</span><dl className="detail-grid"><dt>指派 Agent</dt><dd>{snapshot.agents.find((agent) => agent.id === task.agentId)?.name ?? task.agentId}</dd><dt>后续模型</dt><dd>{model?.name ?? '尚未配置'}</dd><dt>创建时间</dt><dd>{shortDate(task.createdAt)}</dd>{task.acceptedAt && <><dt>验收时间</dt><dd>{shortDate(task.acceptedAt)}</dd></>}</dl>{task.description && <><h4>任务目标</h4><p className="inspector-description">{task.description}</p></>}{task.acceptanceCriteria && <><h4>验收标准</h4><p className="inspector-description">{task.acceptanceCriteria}</p></>}{task.acceptanceNote && <><h4>验收说明</h4><p className="inspector-description">{task.acceptanceNote}</p></>}
        <div className="detail-actions"><Button className="small" onClick={() => onOpenChat(task.sessionId)}><MessageSquare size={13} />进入对话</Button><Button className="small" variant="ghost" onClick={() => onEditTask(task)}><Pencil size={12} />编辑</Button>
          {!active && task.status !== 'done' && task.status !== 'review' && <Button className="small" variant="primary" busy={busy(`start:${task.id}`)} disabled={!snapshot.runtime.ready || !snapshot.models.length} onClick={() => onStart(task)}><Play size={12} />{current ? '重新执行' : '开始执行'}</Button>}
          {task.status === 'review' && !active && current?.status === 'succeeded' && <Button className="small" variant="primary" onClick={() => onAccept(task)}><CheckCheck size={13} />验收通过</Button>}
          {active && <Button className="small" variant="danger" busy={busy(`stop:${active.id}`)} disabled={active.status === 'cancelling'} onClick={() => onStop(active)}>停止执行</Button>}
        </div>
        {task.status === 'review' && <p className="settings-meta">检查交付物与验收标准后确认通过；需要修改时进入对话继续提交。</p>}
      </>}
      {approvals.map((approval) => <ApprovalCard key={approval.requestId} approval={approval} busy={busy(`approval:${approval.requestId}`)} onRespond={onRespond} />)}
      <h4>工作产物 <span className="muted">{artifacts.length ? `· ${artifacts.length}` : ''}</span></h4>
      {artifacts.length ? artifacts.map((artifact) => <button type="button" className="artifact-row" key={artifact.id} onClick={() => onArtifact(artifact)}><span className="file-icon"><FileText size={17} /></span><span className="file-info"><strong title={artifact.relativePath}>{artifact.relativePath}</strong><small>{artifact.change === 'created' ? '新建' : artifact.change === 'deleted' ? '已删除' : '已修改'} · {artifact.size < 1024 ? `${artifact.size} B` : `${Math.round(artifact.size / 1024)} KB`} · {shortDate(artifact.createdAt)}</small></span></button>) : <EmptyState icon={<FileText size={20} />} title="成果会在这里汇集">执行中创建或修改的文件，会关联到当前工作。</EmptyState>}
      <h4>执行历史 <span className="muted">{runs.length ? `· ${runs.length}` : ''}</span></h4>
      {runs.length ? runs.map((run, index) => <div key={run.id} className="run-history"><div className="run-top"><span>第 {runs.length - index} 次执行</span><StatusBadge run={run} /></div><p>{shortDate(run.createdAt)}<br />{run.model.model} · {run.agent.name}<br /><span className="mono">{run.id.slice(0, 14)}</span>{run.retryOf ? ' · 重试记录' : ''}</p>{run.error && <p className="run-error">{run.error}</p>}<p>输入用量：{run.usage?.inputTokens == null ? '未提供' : `${run.usage.inputTokens.toLocaleString()} tokens`}<br />输出用量：{run.usage?.outputTokens == null ? '未提供' : `${run.usage.outputTokens.toLocaleString()} tokens`}</p></div>) : <p className="sidebar-empty">尚未开始执行。</p>}
    </div>
  </aside>;
}
