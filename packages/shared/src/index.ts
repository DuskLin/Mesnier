/** 产品事实由宿主维护；renderer 只能调用明确命令并订阅快照。 */
export type Provider = 'openai' | 'openai_responses' | 'anthropic';
export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done';
export interface ModelConfig {
  id: string; name: string; provider: Provider; baseUrl: string; model: string;
  maxContextSize: number; hasApiKey: boolean;
  status: 'untested' | 'ready' | 'error'; lastTestedAt?: string; error?: string;
}
export interface AgentProfile { id: string; name: string; instructions: string }
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface Session { id: string; projectId: string; title: string; runtimeSessionId?: string; createdAt: string; updatedAt: string }
export interface Task {
  id: string; sessionId: string; projectId: string; title: string; description: string;
  acceptanceCriteria: string; agentId: string; status: TaskStatus; createdAt: string;
  updatedAt: string; acceptedAt?: string; acceptanceNote?: string;
}
export interface Message { id: string; sessionId: string; runId: string; role: 'user' | 'assistant'; text: string; createdAt: string }
export interface RunEvent { id: string; runId: string; kind: string; payload: Record<string, unknown>; at: string }
export interface Approval {
  requestId: string; runId: string; toolName: string; description: string;
  details?: string; createdAt: string;
}
export interface Run {
  id: string; sessionId: string; taskId?: string; projectId: string; requestId: string;
  prompt: string; status: RunStatus; agent: AgentProfile; model: ModelConfig; workspace: string;
  runtimeVersion: string; upstreamCommit: string; createdAt: string; startedAt?: string; endedAt?: string;
  error?: string; retryOf?: string; usage?: { inputTokens?: number; outputTokens?: number };
}
export interface Artifact {
  id: string; runId: string; sessionId: string; projectId: string; path: string;
  relativePath: string; change: 'created' | 'modified' | 'deleted'; size: number; createdAt: string;
}
export interface Snapshot {
  schemaVersion: 1; revision: number; projects: Project[]; sessions: Session[]; tasks: Task[];
  runs: Run[]; messages: Message[]; events: RunEvent[]; approvals: Approval[]; artifacts: Artifact[];
  models: ModelConfig[]; agents: AgentProfile[]; defaultModelId?: string;
  runtime: { ready: boolean; version: string; upstreamCommit: string; error?: string };
  app: { version: string; dataRoot: string; platform: string };
}
export interface ModelInput {
  id?: string; name: string; provider: Provider; baseUrl: string; model: string;
  maxContextSize?: number; apiKey?: string;
}
export interface SendInput { sessionId: string; text: string; requestId: string; modelId?: string; agentId?: string; retryOf?: string }
export interface TaskInput { sessionId: string; title: string; description?: string; acceptanceCriteria?: string; agentId?: string }
export interface ArtifactContent { artifact: Artifact; text?: string; truncated?: boolean; error?: string; binary?: boolean }
export interface MesnierBridge {
  getSnapshot(): Promise<Snapshot>;
  onChange(callback: (snapshot: Snapshot) => void): () => void;
  selectDirectory(): Promise<string | null>;
  createProject(input: { name?: string; path: string }): Promise<Project>;
  removeProject(projectId: string): Promise<void>;
  createSession(input: { projectId: string; title?: string }): Promise<Session>;
  renameSession(input: { sessionId: string; title: string }): Promise<void>;
  sendMessage(input: SendInput): Promise<Run>;
  cancelRun(runId: string): Promise<void>;
  respondApproval(input: { runId: string; requestId: string; decision: 'approved' | 'rejected' }): Promise<void>;
  createTask(input: TaskInput): Promise<Task>;
  updateTask(input: { taskId: string; title?: string; description?: string; acceptanceCriteria?: string; agentId?: string }): Promise<Task>;
  enqueueTask(input: { taskId: string; requestId: string; modelId?: string }): Promise<Run>;
  acceptTask(input: { taskId: string; note?: string }): Promise<Task>;
  saveModelConfig(input: ModelInput): Promise<ModelConfig>;
  testModel(modelId: string): Promise<{ ok: boolean; message: string }>;
  setDefaultModel(modelId: string): Promise<void>;
  deleteModel(modelId: string): Promise<void>;
  readArtifact(artifactId: string): Promise<ArtifactContent>;
  openArtifact(artifactId: string): Promise<void>;
  revealProject(projectId: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
}
declare global { interface Window { mesnier?: MesnierBridge } }
