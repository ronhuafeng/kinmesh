/**
 * The team's T3 sign-in ended. Nothing is sent to T3 under it; the delivery
 * waits for a new sign-in, which is the same authority, so it goes on.
 */
export class SignInEnded extends Error {
  override readonly name = 'SignInEnded';
}
