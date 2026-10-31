// Adapted from DeepSeek packages/deliverables/workspace-changes/src/compare.ts.
// Copyright (c) 2026 DeepSeek. MIT; see workspace-changes-LICENSE.txt.
import { structuredPatch } from 'diff';
const terminated = text => text === '' || text.endsWith('\n') ? text : text + '\n';
const lines = text => text === '' ? [] : text.slice(0, -1).split('\n');
export function compareText(before, after, timeoutMs = 100) {
  const oldText = terminated((before ?? '').replaceAll('\r\n', '\n'));
  const newText = terminated((after ?? '').replaceAll('\r\n', '\n'));
  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, { context: 3, timeout: timeoutMs });
  const coarse = patch === undefined;
  const hunks = patch?.hunks || [{ oldStart: 1, oldLines: lines(oldText).length, newStart: 1, newLines: lines(newText).length,
    lines: [...lines(oldText).map(line => '-' + line), ...lines(newText).map(line => '+' + line)] }];
  let added = 0, deleted = 0;
  for (const hunk of hunks) for (const line of hunk.lines) { if (line.startsWith('+')) added++; else if (line.startsWith('-')) deleted++; }
  return { hunks, coarse, added, deleted };
}
