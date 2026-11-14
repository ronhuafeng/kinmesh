import { useState } from 'react';
import { Notice } from './forms.js';

/** Why Feishu sent the browser back without signing it in. */
const turnedBack: Record<string, string> = {
  denied: 'That Feishu account isn’t part of this organization.',
  expired: 'That sign-in took too long. Try again.',
  unavailable: 'Feishu couldn’t be reached. Try again.',
};

/**
 * Read as the page loads, before the workspace rewrites the address to its
 * own place (which drops it, so a reload starts clean); shown once.
 */
let pending = new URLSearchParams(window.location.search).get('signin');

export function Auth() {
  const [reason] = useState(() => {
    const value = pending === null ? undefined : turnedBack[pending];
    pending = null;
    return value;
  });
  return (
    <main className="auth-shell">
      <section className="auth-intro">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            k
          </span>
          <span>kinmesh</span>
        </a>
        <h1>
          One team.
          <br />A lasting thread.
        </h1>
        <p>
          People and agents in one place, with the conversation, the work and
          the decisions kept together.
        </p>
      </section>
      <section className="auth-card">
        <h2>Welcome</h2>
        <a className="button" href="/login">
          Sign in with Feishu
        </a>
        {reason && <Notice>{reason}</Notice>}
      </section>
    </main>
  );
}
