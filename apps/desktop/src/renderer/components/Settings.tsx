import { useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, CircleAlert, Cpu, Info, KeyRound, Moon, Palette, Plus, Sun, Trash2, X } from 'lucide-react';
import type { MesnierBridge, ModelConfig, ModelInput, Provider, Snapshot } from '@mesnier/shared';
import { Button, IconButton, Modal, readableError, shortDate, useDialogFocus } from './ui';

import logo from '../../../../../assets/brand/mesnier-logo.png';

const baseUrls: Record<Provider, string> = { openai: 'https://api.openai.com/v1', openai_responses: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };
const emptyInput = (): ModelInput => ({ name: '', provider: 'openai', baseUrl: baseUrls.openai, model: '', maxContextSize: 32768, apiKey: '' });

const toInput = (model?: ModelConfig): ModelInput => model ? { id: model.id, name: model.name, provider: model.provider, baseUrl: model.baseUrl, model: model.model, maxContextSize: model.maxContextSize, apiKey: '' } : emptyInput();
const fingerprint = (input: ModelInput) => JSON.stringify([input.id, input.name, input.provider, input.baseUrl, input.model, input.maxContextSize, input.apiKey ?? '']);
const sections = [{ id: 'models', label: '模型服务', icon: Cpu }, { id: 'appearance', label: '外观', icon: Palette }, { id: 'about', label: '关于 Mesnier', icon: Info }] as const;

export function Settings({ snapshot, bridge, onClose, theme, setTheme }: { snapshot: Snapshot; bridge: MesnierBridge; onClose: () => void; theme: 'light' | 'dark'; setTheme: (theme: 'light' | 'dark') => void }) {
  const initial = snapshot.models.find((item) => item.id === snapshot.defaultModelId) ?? snapshot.models[0];
  const [form, setForm] = useState<ModelInput>(toInput(initial));
  const [baseline, setBaseline] = useState(fingerprint(toInput(initial)));
  const [section, setSection] = useState<(typeof sections)[number]['id']>('models');
  const [discard, setDiscard] = useState<{ action: () => void }>();
  const root = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saved = snapshot.models.find((item) => item.id === form.id);
  const patch = (value: Partial<ModelInput>) => { setForm((previous) => ({ ...previous, ...value })); setMessage(undefined); setConfirmDelete(false); };
  const choose = (model?: ModelConfig) => { const input = toInput(model); setForm(input); setBaseline(fingerprint(input)); setMessage(undefined); setConfirmDelete(false); };
  const leave = (action: () => void) => { if (lock.current) return; if (fingerprint(form) !== baseline) setDiscard({ action }); else action(); };
  useDialogFocus(root, () => leave(onClose));
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
    const next = { ...input, id: result.id, apiKey: '' };
    setForm(next); setBaseline(fingerprint(next));
    if (test) { const outcome = await bridge.testModel(result.id); setMessage({ ok: outcome.ok, text: outcome.message }); }
    else setMessage({ ok: true, text: '模型配置已保存。修改用于后续执行，正在进行的工作保持原配置。' });
  });
  return <>
    <div ref={root} role="dialog" aria-modal="true" aria-label="工作台设置" tabIndex={-1} className="settings-page" inert={!!discard}>
      <aside className="settings-nav" aria-label="设置分类">
        <div className="settings-titlebar" />
        <button className="settings-back" type="button" aria-label="返回工作台" title="返回工作台" disabled={pending} onClick={() => leave(onClose)}><ArrowLeft size={17} /><span>返回工作台</span></button>
        <div className="settings-nav-group">偏好设置</div>
        <nav>{sections.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-label={label} title={label} aria-current={section === id ? 'page' : undefined} disabled={pending} onClick={() => setSection(id)}><Icon size={17} /><span>{label}</span></button>)}</nav>
        <div className="settings-nav-brand"><img src={logo} alt="" /><span>Mesnier<small>版本 {snapshot.app.version}</small></span></div>
      </aside>
      <section className="settings-frame">
        <header className="settings-frame-header"><span>设置</span><ChevronRight size={14} /><strong>{sections.find((item) => item.id === section)?.label}</strong><IconButton label="关闭" disabled={pending} onClick={() => leave(onClose)}><X size={18} /></IconButton></header>
        <div className="settings-scroll"><div className="settings-content">
          <div className="settings-page-heading"><h1>{sections.find((item) => item.id === section)?.label}</h1><p>{section === 'models' ? '管理用于对话与任务执行的模型连接。' : section === 'appearance' ? '选择适合你的工作台外观。' : '你的本地 Agent 工作台。'}</p></div>
          {section === 'models' && <div className="model-manager">
            <aside className="model-list" aria-label="模型配置列表"><div className="model-list-heading"><span>已添加的模型</span><Button className="small" disabled={pending} onClick={() => leave(() => choose())}><Plus size={14} /><span>新增</span></Button></div><div className="model-list-items">
              {snapshot.models.map((item) => <button type="button" key={item.id} aria-label={`编辑模型 ${item.name}`} title={item.name} aria-current={form.id === item.id ? 'true' : undefined} disabled={pending} onClick={() => { if (form.id !== item.id) leave(() => choose(item)); }}><span className="model-service-icon"><Cpu size={18} /></span><span className="model-list-copy"><strong>{item.name}</strong><small>{item.model}</small></span>{item.id === snapshot.defaultModelId && <span className="model-default" title="默认模型">默认</span>}</button>)}
              {!form.id && <div className="model-draft-row"><Plus size={18} /><span>新模型配置</span></div>}
            </div><p className="model-list-note">默认模型用于新的对话与任务。</p></aside>
            <div className="model-editor">
    <form className="model-form" onSubmit={(event) => { event.preventDefault(); if (valid) void save(true); }}>
      <div className="model-fields">
      <div className="model-editor-heading"><span className="model-service-icon"><Cpu size={22} /></span><div><h2>{saved?.name ?? '添加模型'}</h2><p>{saved ? '连接与认证' : '填写服务地址和模型信息'}</p></div></div>
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
      </div>
      <div className="model-save-actions"><Button disabled={pending || !valid} onClick={() => void save(false)}>保存配置</Button><Button type="submit" variant="primary" busy={pending} disabled={!valid}>保存并验证</Button></div>
    </form>
    {saved && <div className="detail-actions">
      <Button className="small" disabled={pending || saved.id === snapshot.defaultModelId} onClick={() => void perform(async () => { await bridge.setDefaultModel(saved.id); setMessage({ ok: true, text: '已设为后续执行的默认模型。' }); })}>{saved.id === snapshot.defaultModelId ? <><Check size={13} />默认模型</> : '设为默认模型'}</Button>
      {confirmDelete ? <><Button className="small" variant="danger" disabled={pending} onClick={() => void perform(async () => { await bridge.deleteModel(saved.id); choose(); setMessage({ ok: true, text: '模型配置已删除，已有执行历史保留。' }); })}>确认删除配置</Button><Button className="small" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(false)}>取消</Button></> : <Button className="small" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(true)}><Trash2 size={12} />删除配置</Button>}
    </div>}
            </div>
          </div>}
          {section === 'appearance' && <>
            <h2 className="settings-group-title">主题</h2>
            <div className="appearance-options">{(['light', 'dark'] as const).map((value) => <button type="button" key={value} className={`appearance-option ${value}`} aria-pressed={theme === value} onClick={() => setTheme(value)}><span className="appearance-preview" aria-hidden="true"><i className="preview-sidebar"><b /><b /><b /></i><i className="preview-main"><b /><b /><b /></i></span><span className="appearance-label">{value === 'light' ? <Sun size={16} /> : <Moon size={16} />}{value === 'light' ? '浅色' : '深色'}{theme === value && <Check size={16} />}</span></button>)}</div>
            <h2 className="settings-group-title">键盘快捷键</h2><div className="settings-group-card"><div className="settings-row"><span>新建对话</span><kbd>⌘ / Ctrl + N</kbd></div><div className="settings-row"><span>打开设置</span><kbd>⌘ / Ctrl + ,</kbd></div><div className="settings-row"><span>发送消息 / 换行</span><kbd>Enter / Shift + Enter</kbd></div></div>
          </>}
          {section === 'about' && <>
            <div className="settings-about-brand"><img src={logo} alt="Mesnier" /><div><h2>Mesnier</h2><p>版本 {snapshot.app.version}</p></div></div>
            <h2 className="settings-group-title">应用信息</h2><div className="settings-group-card"><div className="settings-row"><span>平台</span><span>{snapshot.app.platform}</span></div><div className="settings-row"><span>内置运行时</span><span className={snapshot.runtime.ready ? 'runtime-ready' : 'runtime-error'}><span className={`status-dot ${snapshot.runtime.ready ? 'ready' : 'unavailable'}`} />{snapshot.runtime.ready ? '已就绪' : '不可用'}</span></div><div className="settings-row"><span>运行时版本</span><span>{snapshot.runtime.version}</span></div><div className="settings-row settings-path"><span>数据目录</span><span className="mono">{snapshot.app.dataRoot}</span></div></div>
            {snapshot.runtime.error && <div className="inline-notice error"><CircleAlert size={16} /><span>{snapshot.runtime.error}</span></div>}
          </>}
        </div></div>
      </section>
    </div>
    {discard && <Modal title="放弃未保存的修改？" description="当前模型的修改尚未保存。" onClose={() => setDiscard(undefined)}><div className="modal-actions"><Button onClick={() => setDiscard(undefined)}>继续编辑</Button><Button variant="danger" onClick={() => { const action = discard.action; setDiscard(undefined); action(); }}>放弃修改</Button></div></Modal>}
  </>;
}
