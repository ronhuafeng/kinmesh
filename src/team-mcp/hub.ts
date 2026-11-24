import { DomainError, type Refusal } from '../domain/errors.js';

/** The refusal a hub's status stands for. */
const REFUSALS: Partial<Record<number, Refusal>> = {
  400: 'invalid',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  413: 'too-large',
};

/**
 * One request to the hub as the calling agent, with its own credential:
 * for what only the hub may do, such as writing to GitHub with the team's
 * app. The hub decides and answers as it does over HTTP; its refusal comes
 * back as the same refusal, with its reason.
 */
export async function hubRequest(
  hub: string,
  authorization: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, hub), {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new Error('Hub unreachable', { cause: error });
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return json;
  const kind = REFUSALS[response.status];
  if (kind === undefined)
    throw new Error(`Hub answered ${String(response.status)}`);
  const reason =
    typeof json === 'object' &&
    json !== null &&
    'reason' in json &&
    typeof json.reason === 'string'
      ? json.reason
      : undefined;
  throw new DomainError(kind, reason === undefined ? {} : { reason });
}
