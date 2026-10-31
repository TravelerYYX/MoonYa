export const BUILTIN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function resolveBuiltinReasoning(data, caps, work = false) {
  const version = data.reasoningProfileVersion ?? 1;
  if (![1, 2].includes(version)) throw new Error('无效的思考档位版本');
  const legacy = { none: ['none', 'high'], light: ['low', 'low'], medium: ['low', 'high'],
    high: ['high', 'high'], max: ['max', 'high'], ultra: ['max', 'high'] };
  const levels = BUILTIN_EFFORTS.filter(level => caps.efforts?.includes(level));
  const fallback = caps.default_effort || (levels.includes('high') ? 'high' : levels.at(-1) || 'auto');
  let effort = data.reasoningEffort ?? (data.deepThinking === false ? 'none' : fallback);
  let detail = data.image_detail;
  if (version === 1) {
    const profile = legacy[data.reasoningProfile];
    if (data.reasoningProfile && !profile) throw new Error('无效的界面思考档位');
    if (profile) {
      if (detail && detail !== profile[1]) throw new Error('思考强度与图片细节级别不匹配');
      [effort, detail] = profile;
    }
    if (caps.supports_thinking === false) effort = 'none';
    else if (levels.length && !levels.includes(effort)) effort = 'auto';
  } else {
    if (!['none', 'auto', ...BUILTIN_EFFORTS].includes(effort) || data.reasoningProfile && data.reasoningProfile !== effort)
      throw new Error('界面思考档位与请求 effort 不匹配');
    if (!caps.supports_thinking) {
      if (effort !== 'none') throw new Error('所选模型不支持思考模式');
    } else if (effort === 'none') {
      if (work || caps.reasoning === 'always' || caps.reasoning_required || caps.allow_thinking_off === false)
        throw new Error('所选模型不允许关闭思考');
    } else if (levels.length ? !levels.includes(effort) : effort !== 'auto') {
      throw new Error('所选模型不支持该思考强度，请刷新模型配置');
    }
  }
  detail ||= effort === 'low' ? 'low' : 'high';
  if (!['low', 'high'].includes(detail)) throw new Error('图片 detail 必须为 low 或 high');
  return { effort, detail };
}
