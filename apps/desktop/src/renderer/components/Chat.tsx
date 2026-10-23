import { useEffect, useRef } from 'react';
import { ArrowUp, Bot, Check, ChevronRight, CircleAlert, Clock3, LoaderCircle, MessageSquare, ShieldCheck, Square, Terminal, UserRound } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Approval, Message, ModelConfig, Run, RunEvent, Session, Snapshot } from '@mesnier/shared';
import logo from '../../../../../assets/brand/mesnier-logo.png';
import { eventText, isActive, runLabels } from '../model';
import { Button, EmptyState, shortDate } from './ui';

export function StatusBadge({ run }: { run: Run }) {
  return <span className={`status-badge ${run.status}`}><span className={`status-dot ${run.status}`} />{runLabels[run.status]}</span>;
}

export function SafeMarkdown({ children, onOpenLink }: { children: string; onOpenLink: (url: string) => void }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children: label }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) onOpenLink(href); }}>{label}</a>,
    // 自动加载远程图片会泄露当前查看行为；链接由用户明确打开。
    img: ({ src, alt }) => <button type="button" className="button ghost small" onClick={() => { if (typeof src === 'string') onOpenLink(src); }}>查看图片：{alt || '图片链接'}</button>,
  }}>{children}</Markdown></div>;
}

function MessageItem({ message, onOpenLink }: { message: Message; onOpenLink: (url: string) => void }) {
  return <article className={`message ${message.role}`}>
    <div className="message-avatar">{message.role === 'user' ? <UserRound size={14} /> : <img src={logo} alt="" />}</div>
    <div className="message-body"><div className="message-meta"><strong>{message.role === 'user' ? '你' : 'Mesnier'}</strong><time>{shortDate(message.createdAt)}</time></div>
      {message.role === 'user' ? <div className="user-text">{message.text}</div> : <SafeMarkdown onOpenLink={onOpenLink}>{message.text}</SafeMarkdown>}
    </div>
  </article>;
}

function ToolEvent({ event, events, active }: { event: RunEvent; events: RunEvent[]; active: boolean }) {
  const result = events.findLast((item) => item.kind === 'tool.result' && item.payload.toolCallId === event.payload.toolCallId);
  const failed = result?.payload.isError === true;
  const name = typeof event.payload.name === 'string' ? event.payload.name : '工具调用';
  return <details className="tool-event">
    <summary>{result ? (failed ? <CircleAlert size={14} /> : <Check size={14} />) : active ? <LoaderCircle size={14} className="spin" /> : <Terminal size={14} />}<strong>{name}</strong><span className="muted">{result ? (failed ? '调用失败' : '已完成') : active ? '处理中' : '未收到结果'}</span><ChevronRight className="chevron" size={14} /></summary>
    <div className="tool-content"><p className="label">工具参数</p><pre className="code-block">{eventText(event.payload.args) || '无参数'}</pre>
      {result && <><p className="label">执行结果</p><pre className="code-block">{eventText(result.payload.output) || '工具未返回文本内容'}</pre></>}
    </div>
  </details>;
}

export function ApprovalCard({ approval, busy, onRespond }: { approval: Approval; busy: boolean; onRespond: (approval: Approval, decision: 'approved' | 'rejected') => void }) {
  return <div className="approval-card" role="region" aria-label={`工具授权：${approval.toolName}`}>
    <div className="approval-title"><ShieldCheck size={17} />需要你的授权</div>
    <p>{approval.description || `${approval.toolName} 正在等待本次操作的授权。`}</p>
    <span className="status-badge">{approval.toolName}</span>
    {approval.details && <pre className="code-block">{approval.details}</pre>}
    <div className="approval-actions"><Button disabled={busy} onClick={() => onRespond(approval, 'rejected')}>拒绝本次</Button><Button variant="primary" busy={busy} onClick={() => onRespond(approval, 'approved')}>允许本次</Button></div>
  </div>;
}

export function Chat({ snapshot, session, draft, setDraft, selectedModelId, onSelectModel, onSend, onStop, onSettings, onRespond, onRetry, onOpenLink, busy }: {
  snapshot: Snapshot; session: Session; draft: string; setDraft: (text: string) => void; selectedModelId?: string;
  onSelectModel: (id: string) => void; onSend: () => void; onStop: (run: Run) => void; onSettings: () => void;
  onRespond: (approval: Approval, decision: 'approved' | 'rejected') => void; onRetry: (run: Run) => void;
  onOpenLink: (url: string) => void; busy: (key: string) => boolean;
}) {
  const runs = snapshot.runs.filter((run) => run.sessionId === session.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const active = runs.find(isActive);
  const model = snapshot.models.find((item) => item.id === selectedModelId);
  const scroll = useRef<HTMLDivElement>(null);
  const sticky = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastSession = useRef(session.id);
  useEffect(() => {
    if (lastSession.current !== session.id) { sticky.current = true; lastSession.current = session.id; }
    if (sticky.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot.revision, session.id]);
  useEffect(() => { if (input.current) { input.current.style.height = '65px'; input.current.style.height = `${Math.min(input.current.scrollHeight, 190)}px`; } }, [draft, session.id]);
  const canSend = !!draft.trim() && !active && snapshot.runtime.ready && !!model && !busy(`send:${session.id}`);
  return <>
    <div className="conversation" ref={scroll} onScroll={() => { if (scroll.current) sticky.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100; }}>
      <div className="conversation-inner">
        {!runs.length && <EmptyState icon={<MessageSquare size={21} />} title="从一个想法开始">描述目标、交付物或需要解决的问题。Mesnier 会在当前项目目录中与你一起完成工作。</EmptyState>}
        {runs.map((run, index) => {
          const events = snapshot.events.filter((item) => item.runId === run.id);
          const timeline: ({ kind: 'message'; at: string; message: Message } | { kind: 'event'; at: string; event: RunEvent })[] = [
            ...snapshot.messages.filter((message) => message.runId === run.id).map((message) => ({ kind: 'message' as const, at: message.createdAt, message })),
            ...events.filter((event) => ['tool.started', 'error', 'warning', 'approval.resolved'].includes(event.kind)).map((event) => ({ kind: 'event' as const, at: event.at, event })),
          ];
          timeline.sort((a, b) => a.at.localeCompare(b.at));
          return <section key={run.id} data-run-id={run.id}>
            <div className="run-divider"><span>第 {index + 1} 次执行</span><StatusBadge run={run} /><span>{run.model.model}</span></div>
            {timeline.map((item) => {
              if (item.kind === 'message') return <MessageItem key={item.message.id} message={item.message} onOpenLink={onOpenLink} />;
              const event = item.event;
              if (event.kind === 'tool.started') return <ToolEvent key={event.id} event={event} events={events} active={isActive(run)} />;
              if (event.kind === 'approval.resolved') return <div key={event.id} className="system-event"><ShieldCheck size={13} />{event.payload.decision === 'approved' ? '已允许本次工具操作' : event.payload.decision === 'rejected' ? '已拒绝本次工具操作' : '授权请求已取消'}</div>;
              return <div key={event.id} className={`system-event ${event.kind === 'error' ? 'error' : ''}`}><CircleAlert size={14} /><span>{eventText(event.payload.error ?? event.payload.message ?? event.payload)}</span></div>;
            })}
            {snapshot.approvals.filter((item) => item.runId === run.id).map((approval) => <ApprovalCard key={approval.requestId} approval={approval} busy={busy(`approval:${approval.requestId}`)} onRespond={onRespond} />)}
            {isActive(run) && <div className="system-event"><LoaderCircle size={13} className="spin" />{run.status === 'queued' ? '任务已进入串行队列，前一项工作结束后开始。' : run.status === 'cancelling' ? '正在等待运行时确认停止。' : run.status === 'waiting_approval' ? '等待你处理工具授权。' : 'Mesnier 正在处理…'}</div>}
            {run.error && <div className="system-event error"><CircleAlert size={14} /><span>{run.error}</span></div>}
            {['failed', 'cancelled', 'interrupted'].includes(run.status) && <div className="system-event"><Clock3 size={13} /><span>{run.status === 'interrupted' ? '原执行已中断，未自动重跑。' : '历史事件与已产生的文件保留。'}</span><Button className="small" variant="ghost" disabled={!!active} onClick={() => onRetry(run)}>显式重试</Button></div>}
          </section>;
        })}
      </div>
    </div>
    <div className="composer-wrap">
      <div className="composer">
        <textarea ref={input} aria-label="消息输入" placeholder="告诉 Mesnier，你想完成什么…" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (canSend) onSend(); }
        }} />
        <div className="composer-toolbar"><Bot size={15} className="muted" />
          {snapshot.models.length ? <select aria-label="本次执行模型" className="composer-model" value={selectedModelId ?? ''} onChange={(event) => onSelectModel(event.target.value)}>{snapshot.models.map((item: ModelConfig) => <option key={item.id} value={item.id}>{item.name || item.model}</option>)}</select> : <button type="button" className="composer-model" onClick={onSettings}>配置模型服务</button>}
          {active ? <Button className="send" variant="danger" busy={busy(`stop:${active.id}`)} disabled={active.status === 'cancelling'} onClick={() => onStop(active)}><Square size={12} />{active.status === 'cancelling' ? '正在停止' : '停止执行'}</Button> : <Button className="send" variant="primary" disabled={!canSend} busy={busy(`send:${session.id}`)} onClick={onSend}><ArrowUp size={16} />发送</Button>}
        </div>
      </div>
      <div className="composer-note"><span>{active ? '当前执行期间不追加指令；草稿会保留供下一次提交。' : !snapshot.runtime.ready ? '运行时尚未就绪，请在设置中查看诊断。' : !model ? '先配置模型服务，再开始工作。' : '文件修改与命令执行需批准。'}</span><span className="keyboard-hint"><kbd>Enter</kbd> 发送 · <kbd>Shift Enter</kbd> 换行</span></div>
    </div>
  </>;
}
