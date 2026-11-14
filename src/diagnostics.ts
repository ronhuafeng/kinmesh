/**
 * What a failure says about itself, for an operator to find its cause:
 * its name, code, the database constraint it broke and its stack. Never
 * request bodies, cookies, credentials or anything a remote service sent.
 */
export function describeFailure(error: unknown) {
  if (!(error instanceof Error)) return { error: typeof error };
  const record = error as Error & { code?: unknown; constraint?: unknown };
  const constraint =
    typeof record.constraint === 'string'
      ? record.constraint
      : /constraint failed: (.+)$/.exec(error.message)?.[1];
  const cause = error.cause instanceof Error ? error.cause : null;
  const causeCode = cause && 'code' in cause ? cause.code : undefined;
  return {
    error: error.name,
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(constraint ? { constraint } : {}),
    // What it wrapped, such as the address already in use.
    ...(cause
      ? {
          cause: {
            error: cause.name,
            ...(typeof causeCode === 'string' ? { code: causeCode } : {}),
          },
        }
      : {}),
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

/** One line on standard error for a process that could not start or run. */
export function reportFailure(event: string, error: unknown) {
  console.error(
    JSON.stringify({ level: 'error', event, ...describeFailure(error) }),
  );
}
