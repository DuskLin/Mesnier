import { useEffect, useRef, useState } from 'react';
import { CheckCheck, CircleAlert, Copy, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Artifact, ArtifactContent, MesnierBridge, Project, Session, Snapshot, Task } from '@mesnier/shared';
import { Button, Modal, readableError, shortPath } from './ui';

export function ProjectDialog({ bridge, onClose, onCreated }: { bridge: MesnierBridge; onClose: () => void; onCreated: (project: Project) => void }) {
  const [path, setPath] = useState(''); const [name, setName] = useState(''); const [pending, setPending] = useState(false); const lock = useRef(false); const [error, setError] = useState('');
  const choose = async () => {
    if (lock.current) return; lock.current = true; setPending(true); setError('');
    try { const result = await bridge.selectDirectory(); if (result) { setPath(result); if (!name) setName(shortPath(result)); } } catch (cause) { setError(readableError(cause)); } finally { lock.current = false; setPending(false); }
  };
  const create = async () => {
    if (lock.current || !path.trim()) return; lock.current = true; setPending(true); setError('');
    try { const project = await bridge.createProject({ name: name.trim() || undefined, path: path.trim() }); onCreated(project); } catch (cause) { setError(readableError(cause)); } finally { lock.current = false; setPending(false); }
  };
  return <Modal title="添加工作项目" description="选择一个本地文件夹，作为工作与交付物的存放位置。普通文件夹与代码仓库都可以。" onClose={() => { if (!pending) onClose(); }}><form onSubmit={(event) => { event.preventDefault(); void create(); }}>
    <label className="field"><span>项目名称</span><input value={name} disabled={pending} placeholder="为这份工作起个名字" onChange={(event) => setName(event.target.value)} /></label>
    <label className="field"><span>工作目录</span><div className="field-row"><input required value={path} disabled={pending} placeholder="选择或输入绝对目录路径" spellCheck={false} onChange={(event) => setPath(event.target.value)} /><Button disabled={pending} onClick={() => void choose()}><FolderOpen size={15} />选择</Button></div><small>Agent 将在此目录中执行工作。应用会核对目录是否真实存在和可访问。</small></label>
    {error && <div className="inline-notice error" role="alert"><CircleAlert size={15} />{error}</div>}<div className="modal-actions"><Button disabled={pending} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={pending} disabled={!path.trim()}>添加项目</Button></div>
  </form></Modal>;
}

export function TaskDialog({ snapshot, bridge, projectId, session, task, onClose, onSaved }: { snapshot: Snapshot; bridge: MesnierBridge; projectId: string; session?: Session; task?: Task; onClose: () => void; onSaved: (task: Task) => void }) {
  const [title, setTitle] = useState(task?.title ?? session?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [criteria, setCriteria] = useState(task?.acceptanceCriteria ?? '');
  const [agentId, setAgentId] = useState(task?.agentId ?? snapshot.agents[0]?.id ?? '');
  const [pending, setPending] = useState(false); const lock = useRef(false); const sessionRef = useRef(session?.id); const [error, setError] = useState('');
  const save = async () => {
    if (lock.current || !title.trim()) return; lock.current = true; setPending(true); setError('');
    try {
      let result: Task;
      if (task) result = await bridge.updateTask({ taskId: task.id, title: title.trim(), description: description.trim(), acceptanceCriteria: criteria.trim(), agentId: agentId || undefined });
      else {
        // 保存失败后沿用同一会话，避免再次点击创建孤立会话。
        if (!sessionRef.current) sessionRef.current = (await bridge.createSession({ projectId, title: title.trim() })).id;
        result = await bridge.createTask({ sessionId: sessionRef.current, title: title.trim(), description: description.trim(), acceptanceCriteria: criteria.trim(), agentId: agentId || undefined });
      }
      onSaved(result);
    } catch (cause) { setError(readableError(cause)); } finally { lock.current = false; setPending(false); }
  };
  return <Modal title={task ? '编辑任务' : session ? '将对话加入看板' : '新建任务'} description={session ? '沿用当前会话、执行历史与工作产物。创建关联不会重新执行。' : '定义目标与验收标准，创建后由你明确开始执行。'} onClose={() => { if (!pending) onClose(); }}><form onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label className="field"><span>任务标题</span><input required value={title} disabled={pending} placeholder="这项工作要完成什么？" onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="field"><span>目标与背景</span><textarea value={description} disabled={pending} rows={4} placeholder="描述目标、背景资料和希望交付的内容…" onChange={(event) => setDescription(event.target.value)} /></label>
    <label className="field"><span>验收标准</span><textarea value={criteria} disabled={pending} rows={3} placeholder="哪些结果能说明这项工作完成了？" onChange={(event) => setCriteria(event.target.value)} /></label>
    <label className="field"><span>指派 Agent</span><select value={agentId} disabled={pending} onChange={(event) => setAgentId(event.target.value)}>{snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>{task && <small>修改指派只影响后续执行，正在进行的执行保留原配置。</small>}</label>
    {error && <div className="inline-notice error" role="alert"><CircleAlert size={15} />{error}</div>}<div className="modal-actions"><Button disabled={pending} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={pending} disabled={!title.trim()}>{task ? '保存修改' : session ? '加入看板' : '创建任务'}</Button></div>
  </form></Modal>;
}

export function AcceptDialog({ task, bridge, onClose, onAccepted }: { task: Task; bridge: MesnierBridge; onClose: () => void; onAccepted: () => void }) {
  const [note, setNote] = useState(''); const [pending, setPending] = useState(false); const lock = useRef(false); const [error, setError] = useState('');
  const accept = async () => {
    if (lock.current) return; lock.current = true; setPending(true); setError('');
    try { await bridge.acceptTask({ taskId: task.id, note: note.trim() || undefined }); onAccepted(); } catch (cause) { setError(readableError(cause)); } finally { lock.current = false; setPending(false); }
  };
  return <Modal title="确认任务验收" description={`确认「${task.title}」的交付结果已满足你的目标。`} onClose={() => { if (!pending) onClose(); }}>
    {task.acceptanceCriteria && <div className="inline-notice" style={{ marginBottom: 18, whiteSpace: 'pre-wrap' }}>{task.acceptanceCriteria}</div>}
    <label className="field"><span>验收说明（可选）</span><textarea rows={3} value={note} disabled={pending} placeholder="记录你的检查结论…" onChange={(event) => setNote(event.target.value)} /></label>
    {error && <div className="inline-notice error" role="alert"><CircleAlert size={15} />{error}</div>}<div className="modal-actions"><Button disabled={pending} onClick={onClose}>继续检查</Button><Button variant="primary" busy={pending} onClick={() => void accept()}><CheckCheck size={15} />确认验收通过</Button></div>
  </Modal>;
}

export function ArtifactDialog({ artifact, bridge, onClose }: { artifact: Artifact; bridge: MesnierBridge; onClose: () => void }) {
  const [content, setContent] = useState<ArtifactContent>(); const [error, setError] = useState(''); const [version, setVersion] = useState(0); const [copied, setCopied] = useState(false);
  useEffect(() => {
    let current = true; setContent(undefined); setError('');
    void bridge.readArtifact(artifact.id).then((value) => { if (current) setContent(value); }).catch((cause) => { if (current) setError(readableError(cause)); });
    return () => { current = false; };
  }, [artifact.id, bridge, version]);
  const open = async () => { try { await bridge.openArtifact(artifact.id); } catch (cause) { setError(readableError(cause)); } };
  const copy = async () => { try { await bridge.copyText(content?.text ?? ''); setCopied(true); } catch { setError('无法访问剪贴板，请选择并手动复制内容。'); } };
  return <Modal title={artifact.relativePath} description="查看当前文件内容；文件来源与对应执行记录始终保留。" wide onClose={onClose}>
    <p className="artifact-path mono">{artifact.path}<br />来源执行：{artifact.runId}</p>
    {error || content?.error ? <div className="inline-notice error" role="alert"><CircleAlert size={16} />{error || content?.error}</div> : !content ? <div className="loading-state" style={{ height: 160 }}><LoaderCircle className="spin" size={24} />正在读取文件…</div> : content.binary ? <div className="inline-notice"><FolderOpen size={17} />此文件无法作为文本预览，可在文件夹中定位后使用系统应用查看。</div> : <div className="artifact-preview"><pre>{content.text ?? '文件内容为空。'}</pre></div>}
    {content?.truncated && <p className="settings-meta">文件较大，仅展示部分文本。可在文件夹中定位后查看完整内容。</p>}
    <div className="modal-actions"><Button onClick={() => { setVersion((value) => value + 1); setCopied(false); }}><RefreshCw size={14} />刷新</Button><span className="spacer" />{content?.text != null && <Button onClick={() => void copy()}><Copy size={14} />{copied ? '已复制' : '复制内容'}</Button>}<Button variant="primary" disabled={!content || !!content.error} onClick={() => void open()}><FolderOpen size={14} />在文件夹中显示</Button></div>
  </Modal>;
}
