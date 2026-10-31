// Gateways can return plain text or typed text blocks. Never stringify arbitrary objects.
export function modelText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(modelText).join('');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.text?.value === 'string') return value.text.value;
  if (typeof value.thinking === 'string') return value.thinking;
  if (value.summary) return modelText(value.summary);
  return '';
}

export function completionText(message) {
  let content = '', embeddedReasoning = '';
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.thought === true || ['thinking', 'reasoning', 'reasoning_text', 'summary_text'].includes(part?.type)) embeddedReasoning += modelText(part);
      else if (typeof part === 'string' || ['text', 'output_text'].includes(part?.type)) content += modelText(part);
    }
  } else content = modelText(message.content);
  return { content, reasoning: modelText(message.reasoning_content) || modelText(message.reasoning) || embeddedReasoning };
}
