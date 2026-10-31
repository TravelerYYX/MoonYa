import { endpoint, redactError } from './model-config.mjs';
import { resolveModelEffort } from './model-catalog.mjs';
import { randomUUID } from 'node:crypto';
import { normalizeUsage } from './conversation-stats.mjs';
import { guardBuiltinCredits, markCreditSettlement, CreditsExhausted } from './builtin-credit.mjs';
import { protocolHistory, responsesPayload, responsesConsumer } from './model-responses.mjs';
import { modelText, completionText } from './model-text.mjs';
export { responsesPayload } from './model-responses.mjs';

function wireMessage({ _origin, _compaction, _moonya_message_id, _billing, provider_content, ...message }, model) {
  const raw = protocolHistory({ ...message, provider_content }, model, 'openai-completions');
  if (raw?.extra_content) message.extra_content = structuredClone(raw.extra_content);
  else delete message.extra_content;
  if (message.tool_calls) message.tool_calls = message.tool_calls.map(call => {
    const { extra_content, ...clean } = call;
    return raw && extra_content ? { ...clean, extra_content: structuredClone(extra_content) } : clean;
  });
  if (!message.tool_calls?.length) delete message.tool_calls;
  if (!['deepseek', 'kimi', 'always', 'glm', 'minimax'].includes(model.reasoning) && model.provider !== 'kimi' && !(!model.protocol && model.name === 'deepseek-flash')) delete message.reasoning_content;
  return message;
}
export function openaiPayload(model, messages, effort, options = {}) {
  effort = resolveModelEffort(model, effort, options.defaultEffort || 'high', options);
  const payload = { model: model.name, messages: messages.map(message => wireMessage(message, model)), stream: true };
  if (model.supports_stream_usage !== false) payload.stream_options = { include_usage: true };
  const deepseek = model.reasoning === 'deepseek' || (!model.protocol && model.name === 'deepseek-flash');
  const maxTokens = options.maxTokens || model.max_output_tokens;
  if (maxTokens) payload[model.reasoning === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = Math.min(maxTokens, model.max_output_tokens || maxTokens);
  if (deepseek && model.supports_thinking !== false) {
    payload.thinking = { type: effort === 'none' && !model.reasoning_required && model.allow_thinking_off !== false ? 'disabled' : 'enabled' };
    if (payload.thinking.type === 'enabled' && model.efforts?.length) payload.reasoning_effort = effort;
    else if (payload.thinking.type === 'enabled' && model.supports_thinking === undefined) payload.reasoning_effort = ['low', 'high', 'max'].includes(effort) ? effort : 'high';
    if (options.summary) payload.response_format = { type: 'json_object' };
  } else if (['kimi', 'glm'].includes(model.reasoning) && model.supports_thinking !== false) {
    payload.thinking = { type: effort === 'none' && !model.reasoning_required && model.allow_thinking_off !== false ? 'disabled' : 'enabled' };
    if (payload.thinking.type === 'enabled' && model.efforts?.length) payload.reasoning_effort = effort;
  }
  else if (model.reasoning === 'minimax' && model.supports_thinking !== false) {
    payload.thinking = { type: effort === 'none' ? 'disabled' : 'adaptive' };
    if (effort !== 'none' && model.efforts?.length) payload.reasoning_effort = effort;
  }
  else if (model.reasoning === 'gemini' && model.supports_thinking !== false) {
    payload.extra_body = { google: { thinking_config: { include_thoughts: effort !== 'none',
      ...(effort === 'none' ? { thinking_budget: 0 } : { thinking_level: effort }) } } };
  }
  else if (model.reasoning === 'openai' && model.supports_thinking !== false) {
    if (effort === 'none' || model.efforts?.length) payload.reasoning_effort = effort;
  }
  const tools = options.summary ? [] : (options.tools || []);
  if (tools.length && model.supports_tools !== false) {
    payload.tools = tools;
    if (model.supports_tool_choice !== false && !deepseek) payload.tool_choice = 'auto';
    if (model.parallel_tool_calls !== false) payload.parallel_tool_calls = true;
  }
  return payload;
}
function anthropicParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (content || []).map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text || '' };
    if (part.type === 'image_url') {
      const value = part.image_url?.url || '';
      const inline = /^data:(image\/[^;]+);base64,(.*)$/s.exec(value);
      return { type: 'image', source: inline ? { type: 'base64', media_type: inline[1], data: inline[2] } : { type: 'url', url: value } };
    }
    throw new Error('当前协议不支持此文件输入，请重新附加原始图片或文字');
  });
}
export function anthropicPayload(model, messages, options = {}, effort = 'none') {
  effort = resolveModelEffort(model, effort, options.defaultEffort || 'high', options);
  const payload = { model: model.name, max_tokens: Math.min(options.maxTokens || model.max_output_tokens || 4096,
    model.max_output_tokens || 4096), stream: true, messages: [] };
  const systems = [];
  if (model.reasoning === 'anthropic' && model.supports_thinking !== false && effort !== 'none') {
    if (model.thinking_type === 'adaptive' || model.thinking_type === undefined && model.efforts?.length) {
      payload.thinking = { type:'adaptive' };
      if (model.efforts?.includes(effort)) payload.output_config = { effort };
    } else if (payload.max_tokens > 1024) payload.thinking = { type:'enabled', budget_tokens:Math.min(payload.max_tokens - 1, ({low:1024,medium:2048,high:4096,xhigh:8192,max:16384})[effort]) };
    else throw new Error('思考模式的输出预算必须大于 1024 tokens');
  }
  for (const message of messages) {
    if (['system', 'developer'].includes(message.role)) { systems.push(...anthropicParts(message.content)); continue; }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    let content;
    if (message.role === 'tool') content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content || '' }];
    else if (message.role === 'assistant' && message.provider_content?.provider_id === model.provider_id
      && message.provider_content?.model === model.name && Array.isArray(message.provider_content.blocks)
      && (!message.provider_content.protocol || message.provider_content.protocol === 'anthropic-messages')) content = structuredClone(message.provider_content.blocks);
    else {
      content = anthropicParts(message.content);
      for (const call of message.tool_calls || []) content.push({ type: 'tool_use', id: call.id,
        name: call.function.name, input: JSON.parse(call.function.arguments || '{}') });
    }
    if (!content.length) continue;
    const previous = payload.messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else payload.messages.push({ role, content });
  }
  if (systems.length) payload.system = systems;
  if (!options.summary && options.tools?.length && model.supports_tools !== false) payload.tools = options.tools.map(tool => ({
    name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }));
  return payload;
}
export async function* sse(response) {
  const decoder = new TextDecoder(); let buffer = '';
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield data === '[DONE]' ? { moonya_end:true } : JSON.parse(data);
      }
      if (done) {
        const data = buffer.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield data === '[DONE]' ? { moonya_end:true } : JSON.parse(data);
        break;
      }
    }
  } finally { reader.releaseLock(); }
}
export async function callModel(model, messages, effort, signal, onDelta = async () => {}, options = {}) {
  await guardBuiltinCredits(model, signal);
  const hasImages = messages.some(message => Array.isArray(message.content) && message.content.some(part => ['image_url', 'file'].includes(part.type)));
  if (hasImages && model.supports_images === false) throw new Error('所选模型不支持图片输入，请选择支持图片的模型');
  const anthropic = model.protocol === 'anthropic-messages';
  const responses = model.protocol === 'openai-responses';
  const payload = anthropic ? anthropicPayload(model, messages, options, effort) : responses ? responsesPayload(model, messages, effort, options) : openaiPayload(model, messages, effort, options);
  const headers = { 'content-type': 'application/json' };
  if (anthropic) { headers['anthropic-version'] = '2023-06-01'; if (model.api_key) headers['x-api-key'] = model.api_key; }
  else if (model.api_key) headers.authorization = `Bearer ${model.api_key}`;
  const attemptId = randomUUID(); let start = performance.now(), retryWithoutUsage = false;
  let firstToken = null, decodeEnd = null, usage = null, status = 'failed', streaming = false, billing = null;
  const markToken = text => { if (streaming && text) { firstToken ??= performance.now(); decodeEnd = performance.now(); } };
  const metrics = () => ({ id: attemptId, kind: 'model', status, model_id: model.id || model.name,
    model_ref: model.provider_id ? { provider_id: model.provider_id, model_id: model.id || model.name } : null,
    llm_ms: performance.now() - start, ttft_ms: firstToken === null ? null : firstToken - start,
    decode_ms: firstToken === null || decodeEnd === null ? null : decodeEnd - firstToken, usage });
  await options.onMetrics?.({ ...metrics(), status: 'running', llm_ms: null });
  start = performance.now();
  try {
    const response = await fetch(endpoint(model.base_url, anthropic ? '/messages' : responses ? '/responses' : '/chat/completions'), {
      method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error' });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 600);
      if (model.builtin && response.status === 402) {
        markCreditSettlement(model, { exhausted: true }); throw new CreditsExhausted();
      }
      const error = new Error(`模型请求失败（HTTP ${response.status}）：${body}`);
      error.streamUsageUnsupported = !model.builtin && response.status === 400 && Boolean(payload.stream_options)
        && /stream_options|include_usage/i.test(body) && /unsupported|unknown|unrecognized|not allowed|extra|invalid|unexpected/i.test(body);
      throw error;
    }
    const state = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
    const blocks = [], partial = new Map(); let truncated = false, argumentsStarted = false;
    const toolActivity = async () => { if (!argumentsStarted) { argumentsStarted = true; await options.onActivity?.({ phase: 'tool_arguments' }); } };
    streaming = (response.headers.get('content-type') || '').includes('text/event-stream');
    let ended = !streaming;
    const textDelta = async (type, value) => { const text = modelText(value); if (!text) return; markToken(text); state[type === 'content' ? 'content' : 'reasoning_content'] += text; if (streaming || model.protocol) await onDelta({ type, text }); };
    const responseItems = responses ? responsesConsumer(textDelta, toolActivity, markToken) : null;
    const consumeCompletion = async message => {
      const text = completionText(message);
      await textDelta('reasoning', text.reasoning); await textDelta('content', text.content);
      if (message.extra_content || model.reasoning === 'gemini') {
        state.provider_content ||= { protocol: 'openai-completions', provider_id: model.provider_id, model: model.name };
        if (message.extra_content) state.provider_content.extra_content = structuredClone(message.extra_content);
      }
    };
    const consumeAnthropic = async chunk => {
      if (chunk.type === 'message_start' && chunk.message?.usage) usage = { ...normalizeUsage(chunk.message.usage, 'anthropic-messages'), output: null };
      if (chunk.type === 'message_delta' && chunk.usage) {
        const latest = normalizeUsage(chunk.usage, 'anthropic-messages');
        usage = { ...(usage || latest), output: latest.output };
      }
      if (chunk.type === 'content_block_start') {
        blocks[chunk.index] = structuredClone(chunk.content_block);
        if (chunk.content_block.type === 'tool_use') { partial.set(chunk.index, ''); await toolActivity(); }
        if (chunk.content_block.type === 'text') await textDelta('content', chunk.content_block.text);
        if (chunk.content_block.type === 'thinking') await textDelta('reasoning', chunk.content_block.thinking);
      } else if (chunk.type === 'content_block_delta') {
        const block = blocks[chunk.index], delta = chunk.delta;
        if (!block) throw new Error('模型流缺少内容块起始事件');
        if (delta.type === 'text_delta') { block.text = (block.text || '') + delta.text; await textDelta('content', delta.text); }
        if (delta.type === 'thinking_delta') { block.thinking = (block.thinking || '') + delta.thinking; await textDelta('reasoning', delta.thinking); }
        if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
        if (delta.type === 'input_json_delta') { markToken(delta.partial_json); partial.set(chunk.index, (partial.get(chunk.index) || '') + delta.partial_json); }
      } else if (chunk.type === 'message_delta') { truncated ||= chunk.delta?.stop_reason === 'max_tokens'; if (firstToken !== null && chunk.delta?.stop_reason) decodeEnd = performance.now(); }
    };
    if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
      const data = await response.json();
      usage = normalizeUsage(data.usage, model.protocol);
      if (data.error) throw new Error(String(data.error.message || data.error));
      if (responses) await responseItems.complete(data);
      else if (anthropic) { for (const [index, block] of (data.content || []).entries()) await consumeAnthropic({ type: 'content_block_start', index, content_block: block }); }
      else {
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error('模型返回内容格式无效');
        await consumeCompletion(message);
        state.tool_calls = message.tool_calls || [];
        if (state.tool_calls.length) await toolActivity();
      }
      truncated = responses ? responseItems.truncated : (anthropic ? data.stop_reason === 'max_tokens' : data.choices?.[0]?.finish_reason === 'length');
    } else for await (const chunk of sse(response)) {
      if (chunk.type === 'credits_update') {
        billing = chunk.data; markCreditSettlement(model, billing); await options.onBilling?.(billing); continue;
      }
      if (!anthropic && chunk.usage) usage = normalizeUsage(chunk.usage, model.protocol);
      if (chunk.moonya_end || chunk.type === 'message_stop') { if (!responses) ended = true; continue; }
      if (chunk.error?.code === 'credits_exhausted') throw new CreditsExhausted();
      if (chunk.error || chunk.type === 'error') throw new Error(String(chunk.error?.message || chunk.message || '模型流发生错误'));
      if (responses) {
        if (chunk.response?.usage) usage = normalizeUsage(chunk.response.usage, model.protocol);
        await responseItems.consume(chunk); continue;
      }
      if (anthropic) { await consumeAnthropic(chunk); continue; }
      const choice = chunk.choices?.[0]; truncated ||= choice?.finish_reason === 'length';
      if (choice?.finish_reason) { ended = true; if (firstToken !== null) decodeEnd = performance.now(); }
      const delta = choice?.delta || {};
      await consumeCompletion(delta);
      for (const part of delta.tool_calls || []) {
        await toolActivity();
        markToken(part.function?.arguments);
        const index = part.index || 0;
        state.tool_calls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (part.id) state.tool_calls[index].id = part.id;
        if (part.extra_content) {
          state.tool_calls[index].extra_content = structuredClone(part.extra_content);
          state.provider_content ||= { protocol: 'openai-completions', provider_id: model.provider_id, model: model.name };
        }
        if (part.function?.name) state.tool_calls[index].function.name += part.function.name;
        if (part.function?.arguments) state.tool_calls[index].function.arguments += part.function.arguments;
      }
    }
    if (responses) {
      ended = responseItems.ended; truncated = responseItems.truncated;
      usage = normalizeUsage(responseItems.usage, model.protocol);
      if (firstToken !== null && ended) decodeEnd = performance.now();
      Object.assign(state, responseItems.finish(model));
    }
    if (!ended) throw new Error('模型流提前结束，响应不完整，请重新发送。');
    if (anthropic) {
      for (const [index, json] of partial) if (json) blocks[index].input = JSON.parse(json);
      state.tool_calls = blocks.filter(block => block?.type === 'tool_use').map(block => ({
        id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } }));
      state.provider_content = { protocol: 'anthropic-messages', provider_id: model.provider_id, model: model.name, blocks: blocks.filter(Boolean) };
    }
    if (!state.content && !state.reasoning_content && !state.tool_calls.length) throw new Error('模型返回了空响应，请检查模型 ID、输出上限或协议');
    status = 'completed';
    if (billing) state._billing = billing;
    if (options.summary && billing?.exhausted) throw new CreditsExhausted(billing);
    return options.summary && truncated ? { role: 'assistant', content: '' } : state;
  } catch (error) {
    status = signal?.aborted ? 'cancelled' : 'failed';
    if (signal?.aborted) throw error;
    if (error.code === 'credits_exhausted') throw error;
    if (error.streamUsageUnsupported) retryWithoutUsage = true;
    else throw new Error(redactError(error, model.api_key));
  } finally {
    await options.onMetrics?.(metrics());
  }
  if (retryWithoutUsage) return callModel({ ...model, supports_stream_usage: false }, messages, effort, signal, onDelta, options);
}
