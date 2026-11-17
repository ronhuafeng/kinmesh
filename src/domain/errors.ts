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
  /** `cause` keeps what the store saw, such as the constraint, for the log. */
  constructor(
    readonly kind: Refusal,
    options?: ErrorOptions,
  ) {
    super(kind, options);
  }
}
