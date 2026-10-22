/** Mesnier 宿主与独立 Node 子进程之间的 JSONL 契约。 */
export interface RuntimeModelConfig {
  id: string;
  provider: 'openai' | 'openai_responses' | 'anthropic';
  baseUrl: string;
  model: string;
  /** 只允许通过 stdin 传入，宿主持久化记录必须去掉此字段。 */
  apiKey: string;
  maxContextSize?: number;
}

export interface RunInput {
  runId: string;
  /** Mesnier 数据根目录，运行时在其 agent/ 下保存自身数据。 */
  profileRoot: string;
  workspace: string;
  sessionId?: string;
  prompt: string;
  modelConfig: RuntimeModelConfig;
  approvalMode: 'manual' | 'auto';
}

export type RuntimeRequest =
  | { id: string; method: 'info' | 'shutdown'; params?: Record<string, never> }
  | { id: string; method: 'run'; params: RunInput }
  | { id: string; method: 'cancel'; params: { runId: string } }
  | { id: string; method: 'approve'; params: { runId: string; requestId: string; decision: 'approved' | 'rejected' } };

export type RuntimeEventKind =
  | 'session.ready'
  | 'assistant.delta'
  | 'thinking.delta'
  | 'tool.started'
  | 'tool.result'
  | 'tool.progress'
  | 'approval.requested'
  | 'approval.resolved'
  | 'usage'
  | 'error'
  | 'warning'
  | 'turn.step.retrying'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'process.started'
  | 'process.exited';

/**
 * session.ready: {sessionId,resumed,workspace}；assistant/thinking.delta: {text,agentId}。
 * tool.started: {toolCallId,name,args,display?,agentId,sessionId}；tool.result: {toolCallId,output,isError?,agentId,sessionId}。
 * approval.requested: {requestId,toolCallId,toolName,action,display}；approval.resolved: {requestId,decision}。
 * usage: {available,usage}（缺失时 usage=null）；run.*: {sessionId?,error?:{code,message}}。
 * process.started/exited: {pid,pgid?}，只报告本运行时产生的进程身份，不包含命令或环境。
 * leader 退出并不证明进程组后代已全部结束；宿主须确认组消失后才能忘记 pgid。
 * 所有事件具有独立 id，宿主按 id 去重，runId 用于绑定同一次执行。
 */
export interface RuntimeEvent {
  id: string;
  runId: string;
  kind: RuntimeEventKind;
  at: string;
  payload: Record<string, unknown>;
}

export type RuntimeMessage =
  | { event: RuntimeEvent }
  | { id: string | null; result: unknown }
  | { id: string | null; error: { code: string; message: string } };
