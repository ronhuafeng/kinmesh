/** No environment flag, CI reviewer or simulated Human can supply native consent. */
export function requireOwnerNativeApproval(): void {
  throw new Error('approval-required');
}
