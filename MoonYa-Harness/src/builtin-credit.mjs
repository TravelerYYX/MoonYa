const stopped = new Set();
export const QUOTA_MESSAGE = '你已达到使用上限。升级套餐以继续，或在积分重置后再试。';
export class CreditsExhausted extends Error {
  constructor(billing = null) { super(QUOTA_MESSAGE); this.code = 'credits_exhausted'; this.billing = billing; }
}
export function markCreditSettlement(model, billing) {
  if (model.builtin && billing?.exhausted && model.credit_scope) stopped.add(model.credit_scope);
}
export function assertBuiltinCredits(model) {
  if (model?.builtin && model.credit_scope && stopped.has(model.credit_scope)) throw new CreditsExhausted();
}
export async function guardBuiltinCredits(model, signal) {
  if (!model?.builtin) return;
  assertBuiltinCredits(model);
  if (!model.credit_url) throw new Error('内置模型积分服务未连接');
  const response = await fetch(model.credit_url, { headers: { Authorization: 'Bearer ' + model.api_key }, signal, redirect: 'error' });
  const result = await response.json();
  if (!response.ok || !result.success || !result.data?.account) throw new Error('积分信息暂不可用，请稍后重试');
  if (Number(result.data.account.balance) <= 0) {
    markCreditSettlement(model, { exhausted: true }); throw new CreditsExhausted();
  }
}
export function clearCreditScope(scope) { stopped.delete(scope); }
