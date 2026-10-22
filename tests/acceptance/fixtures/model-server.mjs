import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const FIXTURE_API_KEY = 'mesnier-local-fixture-key';

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => typeof item.text === 'string' ? item.text : '').join('\n');
}

/** 显式测试指令；仅服务于隔离验收，不声称具备真实模型推理能力。 */
export function fixturePrompt(scenario) {
  return `本次使用受控协议模型验证真实工具链路。\nMESNIER_TEST=${JSON.stringify(scenario)}`;
}

function scenarioFromPrompt(prompt) {
  const marker = prompt.match(/MESNIER_TEST=(\{[^\n]+\})/);
  if (marker !== null) return JSON.parse(marker[1]);
  // 兼容旧最小探针的具体提示词，使其可直接走真实 harness。
  const path = prompt.match(/path 必须是这个绝对路径：([^\n]+)/)?.[1];
  if (path !== undefined) {
    const content = prompt.match(/content 必须正好是：([^\n]+)/)?.[1];
    return { kind: 'write', path, content: content === undefined ? 'rejected-should-not-land' : JSON.parse(content) };
  }
  if (prompt.includes('连续写三段关于取消语义')) return { kind: 'hold' };
  return { kind: 'text', text: '受控模型连接正常。' };
}

function chunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mesnier-fixture', object: 'chat.completion.chunk', created: 0,
    model: 'mesnier-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export async function startModelServer({ apiKey = FIXTURE_API_KEY } = {}) {
  const requests = [];
  const waiters = new Set();
  const held = new Set();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '受控服务拒绝认证', type: 'authentication_error' } }));
      return;
    }
    try {
      let body = '';
      for await (const part of request) {
        body += part;
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('测试请求超过大小限制');
      }
      const payload = JSON.parse(body);
      const messages = payload.messages ?? [];
      let lastUser = -1;
      let scenarioUser = -1;
      for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].role !== 'user') continue;
        lastUser = i;
        if (/MESNIER_TEST=|path 必须是这个绝对路径：|连续写三段关于取消语义/.test(textContent(messages[i].content))) scenarioUser = i;
      }
      // 上游可能在任务之后追加独立 user 提醒；只以显式 fixture 指令开始新场景。
      if (scenarioUser !== -1) lastUser = scenarioUser;
      const scenario = scenarioFromPrompt(textContent(messages[lastUser]?.content));
      const resultSeen = messages.slice(lastUser + 1).some((message) => message.role === 'tool');
      const called = messages.slice(lastUser + 1).flatMap((message) => message.tool_calls ?? []).map((tool) => tool.function?.name);
      const record = {
        index: requests.length + 1, model: payload.model, kind: scenario.kind,
        resultSeen, toolNames: (payload.tools ?? []).map((tool) => tool.function?.name),
        closed: false,
      };
      requests.push(record);
      for (const waiter of waiters) waiter(record);
      response.once('close', () => { record.closed = true; held.delete(response); });
      if (scenario.kind === 'error') {
        response.writeHead(scenario.status ?? 401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: scenario.echoCredential ? `rejected ${apiKey}` : (scenario.message ?? '受控模型错误'), type: 'authentication_error' } }));
        return;
      }
      if (payload.stream !== true && record.toolNames.includes('mesnier_connection_check')) {
        record.kind = 'connection-check';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
          id: 'connection-check', type: 'function', function: { name: 'mesnier_connection_check', arguments: '{"ready":true}' },
        }] }, finish_reason: 'tool_calls' }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.flushHeaders();
      if (scenario.kind === 'hold') {
        held.add(response);
        response.write(chunk({ role: 'assistant', content: '受控生成已开始，等待取消。' }));
        return;
      }
      if (scenario.kind === 'sse-error') {
        response.write(chunk({ role: 'assistant', content: '受控生成开始后返回错误。' }));
        response.end(`data: ${JSON.stringify({ error: { message: scenario.echoCredential ? `rejected ${apiKey}` : (scenario.message ?? '受控流内错误'), type: 'invalid_request_error', code: 'fixture_stream_error' } })}\n\n`);
        return;
      }
      if (scenario.kind === 'disconnect') {
        response.write(chunk({ role: 'assistant', content: '连接即将中断。' }));
        setImmediate(() => response.destroy());
        return;
      }
      const needsEdit = scenario.kind === 'edit' && !called.includes('Edit');
      if ((['write', 'reject', 'coding', 'bash'].includes(scenario.kind) && !resultSeen) || needsEdit) {
        const toolName = scenario.kind === 'edit' ? (called.includes('Read') ? 'Edit' : 'Read') : scenario.kind === 'bash' ? 'Bash' : 'Write';
        if (!record.toolNames.includes(toolName)) throw new Error(`真实 harness 未提供 ${toolName} 工具`);
        const args = toolName === 'Read' ? { path: scenario.path }
          : toolName === 'Edit' ? { path: scenario.path, old_string: scenario.oldString, new_string: scenario.newString }
          : scenario.kind === 'bash'
          ? { command: scenario.command, ...(scenario.cwd ? { cwd: scenario.cwd } : {}), ...(scenario.timeout ? { timeout: scenario.timeout } : {}) }
          : { path: scenario.path, content: scenario.content, mode: scenario.mode ?? 'overwrite' };
        response.write(chunk({ role: 'assistant', tool_calls: [{
          index: 0, id: `tool-${record.index}`, type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }] }));
        response.write(chunk({}, 'tool_calls'));
      } else {
        const text = resultSeen ? '已收到真实工具结果，本次受控回合结束。' : (scenario.text ?? '受控模型连接正常。');
        response.write(chunk({ role: 'assistant', content: text.slice(0, 4) }));
        response.write(chunk({ content: text.slice(4) }));
        response.write(chunk({}, 'stop'));
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    apiKey,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    waitForRequest(predicate, timeoutMs = 10_000) {
      const found = requests.find(predicate);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const onRequest = (record) => {
          if (!predicate(record)) return;
          clearTimeout(timer); waiters.delete(onRequest); resolve(record);
        };
        const timer = setTimeout(() => { waiters.delete(onRequest); reject(new Error('等待受控模型请求超时')); }, timeoutMs);
        waiters.add(onRequest);
      });
    },
    async close() {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startModelServer();
  process.stdout.write(`${JSON.stringify({ baseUrl: fixture.baseUrl, model: 'mesnier-fixture', modelKind: 'controlled' })}\n`);
  process.once('SIGTERM', () => fixture.close());
  process.once('SIGINT', () => fixture.close());
}
