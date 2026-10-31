import { resolveModelEffort } from './model-catalog.mjs';

export function protocolHistory(message, model, protocol) {
  const raw = message.provider_content;
  return message.role === 'assistant' && raw?.provider_id === model.provider_id && raw?.model === model.name
    && raw.protocol === protocol ? raw : null;
}

export function responsesPayload(model, messages, effort, options = {}) {
  effort = resolveModelEffort(model, effort, options.defaultEffort || 'high', options);
  const payload = { model: model.name, input: [], stream: true, store: false, include: ['reasoning.encrypted_content'] };
  const maximum = options.maxTokens || model.max_output_tokens;
  if (maximum) payload.max_output_tokens = Math.min(maximum, model.max_output_tokens || maximum);
  if (model.supports_thinking !== false) payload.reasoning = { effort, ...(effort !== 'none' ? { summary: 'auto' } : {}) };
  for (const message of messages) {
    if (message.role === 'tool') {
      payload.input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content || '' });
      continue;
    }
    const raw = protocolHistory(message, model, 'openai-responses');
    if (raw?.items?.length) { payload.input.push(...structuredClone(raw.items)); continue; }
    if (message.content) {
      const content = typeof message.content === 'string' ? message.content : message.content.map(part => {
        if (part.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text || '' };
        if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url,
          ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
        throw new Error('Responses 协议不支持此文件输入，请重新附加原始图片或文字');
      });
      payload.input.push({ role: message.role, content });
    }
    for (const call of message.tool_calls || []) payload.input.push({ type: 'function_call', call_id: call.id,
      name: call.function.name, arguments: call.function.arguments || '{}' });
  }
  if (!options.summary && options.tools?.length && model.supports_tools !== false) {
    // Existing tools are permissive JSON schemas. Do not enable Responses' strict default.
    payload.tools = options.tools.map(tool => ({ type: 'function', ...tool.function, strict: false }));
    if (model.supports_tool_choice !== false) payload.tool_choice = 'auto';
    if (model.parallel_tool_calls !== false) payload.parallel_tool_calls = true;
  }
  return payload;
}

/** Reconcile full snapshots with deltas so done/completed events never repeat visible text. */
export function responsesConsumer(textDelta, toolActivity, markToken) {
  const items = new Map(), texts = new Map();
  let ended = false, truncated = false, usage;
  const text = async (index, channel, partIndex, value, append = false) => {
    if (typeof value !== 'string') return;
    const key = `${index}:${channel}:${partIndex}`, previous = texts.get(key) || '';
    const full = append ? previous + value : value;
    if (!full.startsWith(previous)) throw new Error('模型流的最终文本与已收到内容不一致');
    texts.set(key, full);
    await textDelta(channel === 'summary' ? 'reasoning' : 'content', full.slice(previous.length));
  };
  const snapshot = async (index, item) => {
    if (!item || typeof item !== 'object') throw new Error('Responses 返回内容格式无效');
    items.set(index, structuredClone(item));
    if (item.type === 'reasoning') {
      for (const [partIndex, part] of (item.summary || []).entries()) await text(index, 'summary', partIndex, part.text);
    } else if (item.type === 'message') {
      for (const [partIndex, part] of (item.content || []).entries()) await text(index, 'content', partIndex, part.text ?? part.refusal);
    } else if (item.type === 'function_call') await toolActivity();
  };
  const complete = async response => {
    if (!response || !Array.isArray(response.output)) throw new Error('Responses 返回内容格式无效');
    if (response.error || response.status === 'failed') throw new Error(response.error?.message || 'Responses 请求失败');
    if (response.status === 'incomplete') {
      if (response.incomplete_details?.reason !== 'max_output_tokens') throw new Error('Responses 响应不完整：' + (response.incomplete_details?.reason || '未知原因'));
      truncated = true;
    } else if (response.status !== 'completed') throw new Error('Responses 响应尚未完成');
    for (const [index, item] of response.output.entries()) await snapshot(index, item);
    usage = response.usage;
    ended = true;
  };
  const consume = async chunk => {
    const index = chunk.output_index, partIndex = chunk.summary_index ?? chunk.content_index ?? 0;
    if (chunk.type === 'response.failed') throw new Error(chunk.response?.error?.message || 'Responses 请求失败');
    if (['response.completed', 'response.incomplete'].includes(chunk.type)) { await complete(chunk.response); return; }
    if (['response.output_item.added', 'response.output_item.done'].includes(chunk.type)) { await snapshot(index, chunk.item); return; }
    if (chunk.type === 'response.reasoning_summary_text.delta') await text(index, 'summary', partIndex, chunk.delta, true);
    if (chunk.type === 'response.reasoning_summary_text.done') await text(index, 'summary', partIndex, chunk.text);
    if (['response.reasoning_summary_part.added', 'response.reasoning_summary_part.done'].includes(chunk.type)) await text(index, 'summary', partIndex, chunk.part?.text);
    if (['response.output_text.delta', 'response.refusal.delta'].includes(chunk.type)) await text(index, 'content', partIndex, chunk.delta, true);
    if (chunk.type === 'response.output_text.done') await text(index, 'content', partIndex, chunk.text);
    if (chunk.type === 'response.refusal.done') await text(index, 'content', partIndex, chunk.refusal);
    if (['response.content_part.added', 'response.content_part.done'].includes(chunk.type)) await text(index, 'content', partIndex, chunk.part?.text ?? chunk.part?.refusal);
    if (['response.function_call_arguments.delta', 'response.function_call_arguments.done'].includes(chunk.type)) {
      const item = items.get(index);
      if (item?.type !== 'function_call') throw new Error('模型流缺少工具调用起始事件');
      await toolActivity();
      if (chunk.type.endsWith('.delta')) { markToken(chunk.delta); item.arguments = (item.arguments || '') + chunk.delta; }
      else item.arguments = chunk.arguments;
    }
  };
  return { consume, complete, get ended() { return ended; }, get truncated() { return truncated; }, get usage() { return usage; },
    finish(model) {
      const output = [...items].sort(([a], [b]) => a - b).map(([, item]) => item);
      const calls = output.filter(item => item.type === 'function_call');
      if (calls.some(item => !item.call_id || !item.name || typeof item.arguments !== 'string')) throw new Error('Responses 工具调用不完整');
      return { tool_calls: calls.map(item => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } })),
        provider_content: { protocol: 'openai-responses', provider_id: model.provider_id, model: model.name, items: output } };
    } };
}
