import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const origin = new URL(process.env.BANKPILOT_PUBLIC_URL || 'http://localhost:3000').origin;
const app = process.env.BANKPILOT_INTERNAL_URL || 'http://app:3000';
const token = process.env.VOICE_BRIDGE_TOKEN || '';
const key = process.env.VOICE_API_KEY || '';
const model = process.env.VOICE_MODEL || 'grok-voice-latest';
const endpoint = new URL(process.env.VOICE_UPSTREAM_URL || 'ws://grok2api:8000/v1/realtime');
endpoint.searchParams.set('model', model);
const configured = token.length >= 32 && !!key && ['ws:', 'wss:'].includes(endpoint.protocol);
const sessions = new Map();
let pending = 0;
const wss = new WebSocketServer({ noServer: true, maxPayload: 24_000, perMessageDeflate: false });
const server = createServer((request, response) => {
  response.writeHead(request.url === '/health' ? (configured ? 200 : 503) : 404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ configured }));
});
const tools = [
  { type: 'function', name: 'read_bank_facts', description: '读取当前客户的账户、近期流水与订阅，完整本月账单，或理财产品与持仓。', parameters: { type: 'object', properties: { area: { type: 'string', enum: ['overview', 'statement', 'investments'] } }, required: ['area'], additionalProperties: false } },
  { type: 'function', name: 'prepare_banking_task', description: '把用户明确提出的办理需求显示到屏幕，等待用户点击后由页面助手准备。不会执行资金或卡片操作。', parameters: { type: 'object', properties: { request: { type: 'string', description: '保留用户明确说出的业务需求，不猜金额、对象或测评答案。' } }, required: ['request'], additionalProperties: false } },
];
async function context(cookie, body) {
  const response = await fetch(app + '/api/internal/voice/context', { method: 'POST', redirect: 'error', headers: { cookie, origin, 'content-type': 'application/json', 'x-bankpilot-voice-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('SESSION_UNAVAILABLE');
  return response.json();
}
function reject(socket, status) { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
server.on('upgrade', async (request, socket, head) => {
  socket.on('error', () => {});
  if (!configured || pending >= 8 || wss.clients.size >= 8) return reject(socket, '503 Unavailable');
  if (request.url !== '/api/voice/live' || request.headers.origin !== origin || request.headers.authorization || !request.headers.cookie || request.headers.cookie.length > 8192) return reject(socket, '403 Forbidden');
  pending++;
  let customer;
  const cookie = request.headers.cookie;
  try {
    customer = await context(cookie, { action: 'connect' });
    if (socket.destroyed) return;
    if ((sessions.get(customer.customerId) || 0) >= 2) return reject(socket, '429 Too Many Requests');
    sessions.set(customer.customerId, (sessions.get(customer.customerId) || 0) + 1);
  } catch { return reject(socket, '401 Unauthorized'); }
  finally { pending--; }
  const id = customer.customerId;
  const release = () => { const count = (sessions.get(id) || 1) - 1; if (count) sessions.set(id, count); else sessions.delete(id); };
  try { wss.handleUpgrade(request, socket, head, client => connect(client, cookie, customer, release)); }
  catch { release(); socket.destroy(); }
});
function connect(client, cookie, customer, release) {
  const upstream = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 20_000, maxPayload: 1_048_576, perMessageDeflate: false });
  let closed = false, ready = false, responseActive = false, suppressAudio = false, toolCount = 0;
  let bytes = 0, windowAt = Date.now(), checking = false;
  const handled = new Set();
  const jobs = new Map();
  const send = value => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
  const forward = value => { if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(value)); };
  const finish = (message) => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline); clearInterval(heartbeat);
    if (message) send({ type: 'bank.error', message });
    upstream.close(); client.close(1000);
    release();
  };
  const deadline = setTimeout(() => finish('本次通话已结束，可重新拨打。'), 10 * 60_000);
  const heartbeat = setInterval(async () => {
    if (checking || closed) return;
    checking = true;
    try {
      const current = await context(cookie, { action: 'connect' });
      if (current.customerId !== customer.customerId) throw new Error('SESSION_CHANGED');
      if (client.readyState === WebSocket.OPEN) client.ping();
    } catch { finish('登录状态已变化，通话已结束。'); }
    finally { checking = false; }
  }, 25_000);
  const tool = async event => {
    if (!event.call_id || handled.has(event.call_id)) return;
    handled.add(event.call_id);
    const job = (async () => {
      let output;
      try {
        if (++toolCount > 30) throw new Error('TOOL_LIMIT');
        const args = JSON.parse(event.arguments || '{}');
        if (event.name === 'read_bank_facts' && ['overview', 'statement', 'investments'].includes(args.area) && Object.keys(args).length === 1) {
          output = await context(cookie, { action: 'facts', area: args.area });
        } else if (event.name === 'prepare_banking_task' && typeof args.request === 'string' && args.request.trim().length > 0 && args.request.length <= 1000 && Object.keys(args).length === 1) {
          send({ type: 'bank.task_proposal', request: args.request });
          output = { status: 'AWAITING_USER', message: '办理入口已显示，等待用户点击；尚未提交业务或执行交易。' };
        } else throw new Error('TOOL_UNAVAILABLE');
      } catch { output = { error: '当前无法完成该查询或准备，请使用银行页面核对；没有执行业务。' }; }
      if (!closed) forward({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output) } });
    })();
    jobs.set(event.call_id, job);
  };
  upstream.on('open', () => forward({ type: 'session.update', session: { voice: process.env.VOICE_NAME || 'eve', instructions: customer.instructions, turn_detection: { type: 'server_vad' }, audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } }, tools } }));
  upstream.on('message', async raw => {
    if (closed) return;
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }
    if (event.type === 'session.updated' && !ready) {
      ready = true; send({ type: 'bank.ready', model });
      forward({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '通话已接通，请简短问候并询问我需要什么帮助。' }] } });
      forward({ type: 'response.create' });
    } else if (event.type === 'input_audio_buffer.speech_started') {
      suppressAudio = true; send({ type: 'bank.listening' });
      if (responseActive) forward({ type: 'response.cancel' });
    } else if (event.type === 'input_audio_buffer.speech_stopped') send({ type: 'bank.thinking' });
    else if (event.type === 'response.created') { responseActive = true; suppressAudio = false; send({ type: 'bank.response.started' }); }
    else if (['response.output_audio.delta', 'response.audio.delta'].includes(event.type) && !suppressAudio && typeof event.delta === 'string') send({ type: 'bank.audio', audio: event.delta });
    else if (['response.output_audio_transcript.delta', 'response.audio_transcript.delta', 'response.output_text.delta', 'response.text.delta'].includes(event.type) && typeof event.delta === 'string' && !suppressAudio) send({ type: 'bank.caption.delta', delta: event.delta.slice(0, 4000) });
    else if (['response.output_audio_transcript.done', 'response.audio_transcript.done', 'response.output_text.done', 'response.text.done'].includes(event.type) && !suppressAudio) send({ type: 'bank.caption.done', text: (event.transcript || event.text || '').slice(0, 4000) });
    else if (event.type === 'conversation.item.input_audio_transcription.completed' && typeof event.transcript === 'string') send({ type: 'bank.user', text: event.transcript.slice(0, 1000) });
    else if (event.type === 'response.function_call_arguments.done') void tool(event);
    else if (event.type === 'response.done') {
      responseActive = false;
      for (const item of event.response?.output || []) if (item.type === 'function_call') void tool(item);
      const currentJobs = [...jobs.values()]; jobs.clear();
      if (currentJobs.length) { await Promise.allSettled(currentJobs); if (!closed) forward({ type: 'response.create' }); }
      else send({ type: 'bank.response.done' });
    } else if (event.type === 'error') {
      if (event.error?.code === 'response_cancel_not_active') return;
      finish('语音服务暂不可用，请稍后重拨。');
    }
    if (client.bufferedAmount > 1_048_576) finish('连接较慢，请检查网络后重新拨打。');
  });
  client.on('message', raw => {
    if (!ready || closed) return;
    if (Date.now() - windowAt > 10_000) { bytes = 0; windowAt = Date.now(); }
    bytes += raw.length;
    if (bytes > 1_500_000 || upstream.bufferedAmount > 524_288) return finish('网络传输异常，请重新拨打。');
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === 'audio' && typeof event.audio === 'string' && event.audio.length <= 20_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(event.audio)) forward({ type: 'input_audio_buffer.append', audio: event.audio });
      else if (event.type === 'interrupt') { if (responseActive) forward({ type: 'response.cancel' }); suppressAudio = true; }
      else finish('语音连接已结束。');
    } catch { finish('语音连接已结束。'); }
  });
  client.on('close', () => finish()); client.on('error', () => finish());
  upstream.on('error', () => finish('暂时无法连接语音服务，请稍后重拨。'));
  upstream.on('close', () => finish(closed ? undefined : '语音服务连接已结束。'));
}
server.listen(Number(process.env.PORT || 3011), '0.0.0.0');
process.on('SIGTERM', () => { for (const client of wss.clients) client.close(1001); server.close(); setTimeout(() => process.exit(0), 1500).unref(); });
