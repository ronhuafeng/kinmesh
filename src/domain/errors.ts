/**
 * Why a request is refused, in the domain's terms. Whatever answers outside
 * the hub (HTTP, Team MCP) maps the kind to its own terms.
 */
export type Refusal =
  | 'invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  /** Larger than allowed: a file, or the team's room for files. */
  | 'too-large';
export class DomainError extends Error {
  override readonly name = 'DomainError';
  /**
   * A fixed word the caller may be told, where the kind alone leaves them
   * unable to say what to change (such as `branch-taken`); null otherwise.
   */
  readonly reason: string | null;
  /** `cause` keeps what the store saw, such as the constraint, for the log. */
  constructor(
    readonly kind: Refusal,
    options?: ErrorOptions & { reason?: string },
  ) {
    super(kind, options);
    this.reason = options?.reason ?? null;
  }
}
