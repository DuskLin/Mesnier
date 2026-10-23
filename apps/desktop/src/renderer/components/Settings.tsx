import { useRef, useState } from 'react';
import { Check, CircleAlert, Cpu, KeyRound, Moon, Plus, Sun, Trash2 } from 'lucide-react';
import type { MesnierBridge, ModelConfig, ModelInput, Provider, Snapshot } from '@mesnier/shared';
import { Button, Modal, readableError, shortDate } from './ui';

const baseUrls: Record<Provider, string> = { openai: 'https://api.openai.com/v1', openai_responses: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };
const emptyInput = (): ModelInput => ({ name: '', provider: 'openai', baseUrl: baseUrls.openai, model: '', maxContextSize: 32768, apiKey: '' });

export function Settings({ snapshot, bridge, onClose, theme, setTheme }: { snapshot: Snapshot; bridge: MesnierBridge; onClose: () => void; theme: 'light' | 'dark'; setTheme: (theme: 'light' | 'dark') => void }) {
  const initial = snapshot.models.find((item) => item.id === snapshot.defaultModelId) ?? snapshot.models[0];
  const [form, setForm] = useState<ModelInput>(initial ? { ...initial, apiKey: '' } : emptyInput());
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saved = snapshot.models.find((item) => item.id === form.id);
  const patch = (value: Partial<ModelInput>) => { setForm((previous) => ({ ...previous, ...value })); setMessage(undefined); setConfirmDelete(false); };
  const choose = (model?: ModelConfig) => { setForm(model ? { id: model.id, name: model.name, provider: model.provider, baseUrl: model.baseUrl, model: model.model, maxContextSize: model.maxContextSize, apiKey: '' } : emptyInput()); setMessage(undefined); setConfirmDelete(false); };
  const contextSize = form.maxContextSize ?? 0;
  const valid = !!form.name.trim() && !!form.baseUrl.trim() && !!form.model.trim() && Number.isInteger(contextSize) && contextSize >= 1024 && contextSize <= 10000000;
  const perform = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setPending(true); setMessage(undefined);
    try { await work(); } catch (error) { setMessage({ ok: false, text: readableError(error) }); } finally { lock.current = false; setPending(false); }
  };
  const save = async (test: boolean) => perform(async () => {
    const input: ModelInput = { ...form, name: form.name.trim(), model: form.model.trim(), baseUrl: form.baseUrl.trim(), apiKey: form.apiKey?.trim() || undefined };
    const result = await bridge.saveModelConfig(input);
    setForm((previous) => ({ ...previous, id: result.id, apiKey: '' }));
    if (test) { const outcome = await bridge.testModel(result.id); setMessage({ ok: outcome.ok, text: outcome.message }); }
    else setMessage({ ok: true, text: '模型配置已保存。修改用于后续执行，正在进行的工作保持原配置。' });
  });
  return <Modal title="工作台设置" description="配置模型连接与外观，让 Mesnier 适应你的工作方式。" onClose={() => { if (!pending) onClose(); }}>
    {snapshot.models.length > 0 && <div className="field"><label className="field-label" htmlFor="saved-model">模型配置</label><div className="field-row"><select id="saved-model" disabled={pending} value={form.id ?? ''} onChange={(event) => choose(snapshot.models.find((item) => item.id === event.target.value))} style={{ flex: 1, minWidth: 0 }}><option value="">新模型配置</option>{snapshot.models.map((item) => <option key={item.id} value={item.id}>{item.name}{item.id === snapshot.defaultModelId ? ' · 默认' : ''}</option>)}</select><Button disabled={pending} onClick={() => choose()}><Plus size={14} />新增</Button></div></div>}
    <form onSubmit={(event) => { event.preventDefault(); if (valid) void save(true); }}>
      <div className="form-grid">
        <label className="field"><span>配置名称</span><input required disabled={pending} value={form.name} placeholder="例如：我的工作模型" onChange={(event) => patch({ name: event.target.value })} /></label>
        <label className="field"><span>接口协议</span><select disabled={pending} value={form.provider} onChange={(event) => { const provider = event.target.value as Provider; patch({ provider, baseUrl: baseUrls[provider] }); }}><option value="openai">OpenAI Chat</option><option value="openai_responses">OpenAI Responses</option><option value="anthropic">Anthropic</option></select></label>
      </div>
      <label className="field"><span>API 地址</span><input required type="url" disabled={pending} value={form.baseUrl} placeholder={baseUrls[form.provider]} spellCheck={false} onChange={(event) => patch({ baseUrl: event.target.value })} /><small>填写服务提供的接口地址，具体兼容性以连接验证和实际执行为准。</small></label>
      <div className="form-grid">
        <label className="field"><span>模型名称</span><input required disabled={pending} value={form.model} placeholder="服务提供的模型 ID" spellCheck={false} onChange={(event) => patch({ model: event.target.value })} /></label>
        <label className="field"><span>上下文长度</span><input required type="number" min={1024} max={10000000} step={1} disabled={pending} value={form.maxContextSize} onChange={(event) => patch({ maxContextSize: Number(event.target.value) })} /><small>填写 1024～10000000 之间的整数。</small></label>
      </div>
      <label className="field"><span><KeyRound size={12} style={{ verticalAlign: '-2px', marginRight: 5 }} />API 密钥</span><input type="password" autoComplete="new-password" disabled={pending} value={form.apiKey ?? ''} spellCheck={false} placeholder={saved?.hasApiKey ? '已安全保存；留空保留现有密钥' : '填写服务提供的密钥'} onChange={(event) => patch({ apiKey: event.target.value })} /><small>密钥由应用在本机加密保存。当前界面无法读取已保存的密钥。</small></label>
      {message ? <div className={`inline-notice ${message.ok ? 'success' : 'error'}`} role="status">{message.ok ? <Check size={16} /> : <CircleAlert size={16} />}<span>{message.text}</span></div> : saved && <div className={`inline-notice ${saved.status === 'ready' ? 'success' : saved.status === 'error' ? 'error' : ''}`}><Cpu size={16} /><span>{saved.status === 'ready' ? '连接验证通过' : saved.status === 'error' ? saved.error || '上次验证失败' : '配置已保存，尚未验证连接'}{saved.lastTestedAt ? ` · ${shortDate(saved.lastTestedAt)}` : ''}</span></div>}
      <div className="modal-actions"><Button disabled={pending || !valid} onClick={() => void save(false)}>保存配置</Button><Button type="submit" variant="primary" busy={pending} disabled={!valid}>保存并验证</Button></div>
    </form>
    {saved && <div className="detail-actions">
      <Button className="small" disabled={pending || saved.id === snapshot.defaultModelId} onClick={() => void perform(async () => { await bridge.setDefaultModel(saved.id); setMessage({ ok: true, text: '已设为后续执行的默认模型。' }); })}>{saved.id === snapshot.defaultModelId ? <><Check size={13} />默认模型</> : '设为默认模型'}</Button>
      {confirmDelete ? <><Button className="small" variant="danger" disabled={pending} onClick={() => void perform(async () => { await bridge.deleteModel(saved.id); choose(); setMessage({ ok: true, text: '模型配置已删除，已有执行历史保留。' }); })}>确认删除配置</Button><Button className="small" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(false)}>取消</Button></> : <Button className="small" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(true)}><Trash2 size={12} />删除配置</Button>}
    </div>}
    <div className="settings-section"><h3>外观</h3><div className="theme-options"><button type="button" className={`theme-option ${theme === 'light' ? 'selected' : ''}`} onClick={() => setTheme('light')}><Sun size={15} />浅色</button><button type="button" className={`theme-option ${theme === 'dark' ? 'selected' : ''}`} onClick={() => setTheme('dark')}><Moon size={15} />深色</button></div></div>
    <div className="settings-section"><h3>应用与内置运行时</h3><div className={`inline-notice ${snapshot.runtime.ready ? 'success' : 'error'}`}><Cpu size={16} /><span>{snapshot.runtime.ready ? '内置运行时已就绪' : snapshot.runtime.error || '内置运行时不可用'}</span></div><div className="settings-meta">Mesnier {snapshot.app.version} · {snapshot.app.platform}<br />运行时 {snapshot.runtime.version}<br />数据目录：<span className="mono">{snapshot.app.dataRoot}</span></div></div>
  </Modal>;
}
