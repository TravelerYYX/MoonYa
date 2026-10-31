const model = (id, context_window, max_output_tokens, extra = {}) => ({ id, name: id, context_window,
  context_window_source: context_window == null ? 'unknown' : 'official',
  max_output_tokens, supports_images: false, supports_tools: true, supports_chat: true, ...extra });
export const PROVIDER_PRESETS = {
  deepseek: { name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', protocol: 'openai-completions',
    source_url: 'https://api-docs.deepseek.com/api/list-models/', models: [
      model('deepseek-flash', 1048576, 393216, { supports_images: true, reasoning: 'deepseek', efforts: ['low', 'high', 'max'] }),
      model('deepseek-v4-pro', 1048576, 393216, { reasoning: 'deepseek', efforts: ['low', 'high', 'max'] })] },
  kimi: { name: 'Kimi', base_url: 'https://api.moonshot.cn/v1', protocol: 'openai-completions',
    source_url: 'https://platform.kimi.com/docs/models', models: [
      model('kimi-k3', 1048576, 131072, { supports_images: true, reasoning: 'openai', reasoning_required: true, efforts: ['low', 'high', 'max'] }),
      model('kimi-k2.6', 262144, 32768, { supports_images: true, reasoning: 'kimi' }),
      model('kimi-k2.7-code', 262144, 32768, { supports_images: true, reasoning: 'kimi' }),
      model('kimi-k2.7-code-highspeed', 262144, 32768, { supports_images: true, reasoning: 'kimi' })] },
  glm: { name: 'GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai-completions',
    source_url: 'https://docs.bigmodel.cn/cn/guide/start/model-overview', models: [
      model('glm-5.3', null, 131072, { reasoning: 'glm', reasoning_required:true, efforts:['low','high','max'] }),
      model('glm-5.3-flash', null, 131072, { supports_images: true, reasoning: 'glm', efforts:['low','high','max'] })] },
  minimax: { name: 'MiniMax', base_url: 'https://api.minimaxi.com/v1', protocol: 'openai-completions',
    source_url: 'https://platform.minimax.cn/docs/guides/text-generation', models: [
      model('MiniMax-M3', 1000000, 4096, { supports_images: true, reasoning: 'minimax' }),
      model('MiniMax-M2.7', 204800, 4096, { reasoning: 'always' }),
      model('MiniMax-M2.5', 204800, 4096, { reasoning: 'always' })] },
  openai: { name: 'OpenAI', base_url: 'https://api.openai.com/v1', protocol: 'openai-completions',
    source_url: 'https://developers.openai.com/api/docs/models', models: [
      model('gpt-4.1', 1047576, 32768, { supports_images: true }),
      model('gpt-4.1-mini', 1047576, 32768, { supports_images: true }),
      model('gpt-4o', 128000, 16384, { supports_images: true }),
      model('gpt-4o-mini', 128000, 16384, { supports_images: true }),
      model('o3', 200000, 100000, { supports_images: true, reasoning: 'openai', efforts: ['low', 'medium', 'high'] }),
      model('gpt-6.1-sol', 1050000, 128000, { supports_images: true, reasoning: 'openai', supports_thinking: true,
        reasoning_required: true, allow_thinking_off: false,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium', recommended_protocol: 'openai-responses' }),
      model('gpt-6-sol', 1050000, 128000, { supports_images: true, reasoning: 'openai', supports_thinking: true,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium', recommended_protocol: 'openai-responses' })] },
};
// Exact IDs only. Gateways may mix providers; manual overrides still win.
const GATEWAY_MODELS = {
  'gpt-6.1-sol': PROVIDER_PRESETS.openai.models.find(row => row.id === 'gpt-6.1-sol'),
  'gpt-6-sol': PROVIDER_PRESETS.openai.models.find(row => row.id === 'gpt-6-sol'),
  // Google documents an input limit, not a combined context window. Keep it unknown.
  'gemini-3.8-flash': model('gemini-3.8-flash', null, 65536, { supports_images: true, supports_thinking: true,
    reasoning: 'gemini', reasoning_required: true, allow_thinking_off: false,
    efforts: ['low', 'medium', 'high'], default_effort: 'medium' }),
};

export function requireModelContext(row) {
  if (!Number.isSafeInteger(row?.context_window) || row.context_window < 1)
    throw new Error('请先配置该模型已确认的真实上下文长度');
  return row.context_window;
}

export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const MODEL_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const ADVANCED_FIELDS = ['supports_thinking', 'reasoning_required', 'allow_thinking_off', 'default_effort', 'efforts', 'reasoning', 'thinking_type', 'custom_protocol', 'protocol', 'context_window_options'];

/** Resolve a requested operating window against the trusted model catalog. */
export function resolveContextLimit(model, requested) {
  const maximum = requireModelContext(model);
  const choices = model.context_window_options?.length ? model.context_window_options : [maximum];
  if (requested === undefined || requested === null) return maximum;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > maximum || !choices.includes(requested))
    throw new Error('所选上下文档位不可用，请重新选择');
  return requested;
}

/** Explicit session choices take precedence over model defaults and request defaults. */
export function resolveModelEffort(model, requested = 'auto', fallback = 'high', { summary = false } = {}) {
  if (model.supports_thinking === undefined) {
    if (summary && !model.reasoning_required) return 'none';
    return requested === 'auto' || requested == null ? fallback : requested;
  }
  if (!model.supports_thinking) {
    if (!['auto', 'none', undefined, null].includes(requested)) throw new Error('所选模型不支持思考模式');
    return 'none';
  }
  const required = model.reasoning === 'always' || model.reasoning_required || model.allow_thinking_off === false;
  const levels = (model.efforts || []).filter(level => MODEL_EFFORTS.includes(level));
  const automatic = requested == null || requested === 'auto' || summary;
  let effort = automatic ? (summary ? 'none' : model.default_effort !== 'auto' && model.default_effort ? model.default_effort : fallback) : requested;
  if (automatic && effort === 'none' && required) effort = levels.includes('high') ? 'high' : levels[0] || 'high';
  if (effort === 'none') {
    if (required) throw new Error('所选模型不允许关闭思考');
    return effort;
  }
  if (!MODEL_EFFORTS.includes(effort)) throw new Error('模型思考强度无效');
  if (levels.length && !levels.includes(effort)) {
    if (!automatic) throw new Error('所选模型不支持该思考强度');
    effort = levels.includes('high') ? 'high' : levels[0];
  }
  return effort;
}

export function normalizeModel(row, provider, protocol, { stored = false } = {}) {
  if (!row || typeof row.id !== 'string' || !row.id.trim()) throw new Error('模型 ID 不能为空');
  const id = row.id.trim();
  if (id.length > 256 || /[\r\n\0]/.test(id)) throw new Error('模型 ID 无效');
  const known = PROVIDER_PRESETS[provider]?.models.find(item => item.id === id) || GATEWAY_MODELS[id] || {};
  const result = { ...model(id, null, 4096), ...known };
  result.name = String(row.name || row.display_name || known.name || id);
  // Old saved rows contain synthesized 32K values with no provenance. Only
  // fresh API metadata, explicit manual overrides, or verified presets count.
  const apiContext = !stored || row.context_window_source === 'api' || row.defaults?.context_window_source === 'api';
  const inherited = {};
  for (const field of ['context_window', 'context_window_source', 'max_output_tokens', 'context_window_options']) if (Object.hasOwn(row.defaults || {}, field)) inherited[field] = row.defaults[field];
  const apiWindow = (inherited.context_window ?? row.context_window) == null ? null : Number(inherited.context_window ?? row.context_window);
  if (apiContext && Number.isSafeInteger(apiWindow) && apiWindow > 0) {
    result.context_window = apiWindow;
    result.context_window_source = 'api';
  }
  result.max_output_tokens = Number(inherited.max_output_tokens ?? row.max_output_tokens ?? row.max_tokens ?? known.max_output_tokens ?? 4096);
  result.defaults = { context_window: apiContext && Number.isSafeInteger(apiWindow) && apiWindow > 0 ? apiWindow : known.context_window ?? null, context_window_source: result.context_window_source, max_output_tokens: result.max_output_tokens, ...inherited };
  if (Array.isArray(row.context_window_options) && !inherited.context_window_options && !Object.hasOwn(row.overrides || {}, 'context_window_options')) result.defaults.context_window_options = [...row.context_window_options];
  if (Array.isArray(row.input_modalities)) result.supports_images = row.input_modalities.includes('image');
  if (Array.isArray(row.output_modalities) && !row.output_modalities.includes('text')) result.supports_chat = false;
  if (row.effort?.supported_levels) { result.efforts = row.effort.supported_levels; result.reasoning = provider === 'deepseek' ? 'deepseek' : 'openai'; }
  const caps = row.capabilities || {};
  if (caps.vision) result.supports_images = caps.vision.supported === true;
  if (caps.tool_use) result.supports_tools = caps.tool_use.supported === true;
  if (protocol === 'anthropic-messages' && caps.thinking?.supported) {
    result.reasoning = 'anthropic';
    result.thinking_type = caps.thinking.types?.adaptive?.supported ? 'adaptive' : 'enabled';
    if (caps.effort?.supported) result.efforts = ['low', 'medium', 'high', 'max'].filter(level => caps.effort[level]?.supported);
  }
  for (const field of ['supports_images', 'supports_tools', 'supports_chat', 'supports_tool_choice', 'parallel_tool_calls', 'reasoning_required']) {
    if (row[field] !== undefined) { if (typeof row[field] !== 'boolean') throw new Error('模型能力字段必须是布尔值'); result[field] = row[field]; }
  }
  if (row.reasoning) result.reasoning = String(row.reasoning);
  if (row.thinking_type) result.thinking_type = row.thinking_type;
  if (row.efforts) result.efforts = row.efforts;
  const overrides = {};
  for (const field of ADVANCED_FIELDS) if (Object.hasOwn(row, field)) result[field] = row[field];
  // Older normalized API rows synthesized "no thinking" without a capability source.
  // Editor choices live in overrides; only refresh the old synthesized profile.
  if (stored && known.supports_thinking && row.source === 'api' && row.overrides
      && row.supports_thinking === false && !row.reasoning && !Object.hasOwn(row.overrides, 'supports_thinking')) {
    for (const field of ['supports_thinking', 'reasoning', 'reasoning_required', 'allow_thinking_off', 'efforts', 'default_effort']) {
      if (Object.hasOwn(known, field)) result[field] = known[field];
      else delete result[field];
    }
  }
  for (const field of ['id', 'name', 'context_window', 'max_output_tokens', 'supports_images', 'supports_tools', ...ADVANCED_FIELDS]) {
    if (Object.hasOwn(row.overrides || {}, field)) overrides[field] = row.overrides[field];
  }
  Object.assign(result, overrides);
  if (Object.hasOwn(overrides, 'context_window')) {
    result.context_window = overrides.context_window == null ? null : Number(overrides.context_window);
    result.context_window_source = result.context_window == null ? 'unknown' : 'manual';
  } else if (stored && row.context_window_source === 'manual' && row.context_window != null) {
    result.context_window = Number(row.context_window);
    result.context_window_source = 'manual';
  }
  result.id = id;
  for (const field of ['context_window', 'max_output_tokens']) {
    if (field === 'context_window' && result[field] == null) continue;
    if (!Number.isSafeInteger(result[field]) || result[field] < 1) throw new Error('模型 token 上限必须是正整数');
  }
  for (const field of ['supports_images', 'supports_tools']) if (typeof result[field] !== 'boolean') throw new Error('模型能力字段必须是布尔值');
  result.custom_protocol ??= false;
  if (typeof result.custom_protocol !== 'boolean') throw new Error('自定义协议字段必须是布尔值');
  if (result.custom_protocol && !MODEL_PROTOCOLS.includes(result.protocol)) throw new Error('模型 API 协议无效');
  const effectiveProtocol = result.custom_protocol ? result.protocol : protocol;
  const formats = ['deepseek', 'kimi', 'glm', 'openai', 'anthropic', 'always', 'minimax', 'gemini'];
  if (!result.reasoning || result.reasoning === 'auto') {
    result.reasoning = effectiveProtocol === 'anthropic-messages' ? (result.supports_thinking ? 'anthropic' : '') : known.reasoning || ({ deepseek:'deepseek', kimi:'kimi', glm:'glm', minimax:'minimax' })[provider] || (['openai-responses'].includes(effectiveProtocol) || provider === 'openai' && result.supports_thinking ? 'openai' : '');
  }
  if (result.reasoning && !formats.includes(result.reasoning)) throw new Error('模型推理能力无效');
  if (result.thinking_type !== undefined && !['enabled', 'adaptive'].includes(result.thinking_type)) throw new Error('模型思考类型无效');
  result.supports_thinking ??= !!result.reasoning;
  result.reasoning_required ??= result.reasoning === 'always';
  result.allow_thinking_off ??= !result.reasoning_required;
  for (const field of ['supports_thinking', 'reasoning_required', 'allow_thinking_off']) if (typeof result[field] !== 'boolean') throw new Error('模型能力字段必须是布尔值');
  if (result.supports_thinking) {
    if (!formats.includes(result.reasoning)) throw new Error('请选择该模型的思考参数格式');
    if ((effectiveProtocol === 'anthropic-messages') !== (result.reasoning === 'anthropic')) throw new Error('思考参数格式与模型 API 协议不兼容');
    if (effectiveProtocol === 'openai-responses' && result.reasoning !== 'openai') throw new Error('Responses 协议需要 OpenAI 思考参数格式');
    if (result.reasoning === 'always') result.reasoning_required = true;
    if (result.reasoning_required) result.allow_thinking_off = false;
  } else { result.reasoning_required = false; result.allow_thinking_off = false; }
  result.efforts ??= [];
  if (!Array.isArray(result.efforts) || result.efforts.some(level => !['none', 'minimal', ...MODEL_EFFORTS].includes(level))) throw new Error('模型推理档位无效');
  result.efforts = [...new Set(result.efforts.filter(level => MODEL_EFFORTS.includes(level)))];
  if (result.supports_thinking && result.reasoning === 'always' && result.efforts.length) throw new Error('始终思考格式不支持强度调节，请清空支持的档位');
  result.default_effort ??= 'auto';
  if (result.default_effort !== 'auto' && (!result.supports_thinking || !result.efforts.includes(result.default_effort))) throw new Error('默认思考强度必须属于支持的档位');
  let choices = result.context_window_options ?? (row.defaults?.context_window_options || [result.context_window].filter(Boolean));
  if (Object.hasOwn(overrides, 'context_window') && !Object.hasOwn(overrides, 'context_window_options') && Array.isArray(choices)) choices = choices.filter(value => value <= result.context_window);
  if (!Array.isArray(choices) || choices.some(value => !Number.isSafeInteger(value) || value < 1 || result.context_window == null || value > result.context_window)) throw new Error('上下文档位必须是窗口上限内的正整数');
  result.context_window_options = [...new Set([...choices, ...[result.context_window].filter(Boolean)])].sort((a,b) => a-b);
  result.source = ['api', 'preset', 'manual'].includes(row.source) ? row.source : 'api';
  result.overrides = overrides;
  const protocolKey = effectiveProtocol === 'anthropic-messages' ? 'anthropic_messages' : effectiveProtocol === 'openai-responses' ? 'responses' : 'chat_completions';
  if (row.api_capabilities?.[protocolKey]?.supported === false ||
      /^(text-embedding|embedding|whisper|tts-|dall-e|gpt-image|omni-moderation|text-moderation|sora|cogview|cogvideo|glm-image|speech-|music-|babbage|davinci)/i.test(id)
      || /realtime|transcribe|audio|codex|deep-research|(^|-)pro($|-)/i.test(provider === 'openai' ? id : '')) result.supports_chat = false;
  if (!result.supports_chat) result.unavailable_reason = row.unavailable_reason || '该模型不支持当前文本对话协议';
  return result;
}
