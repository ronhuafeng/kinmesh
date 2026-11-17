import { useEffect, useState } from 'react';
import { Notice } from './forms.js';

/** Why Feishu sent the browser back without signing it in. */
const turnedBack: Record<string, string> = {
  denied: '这个飞书账号不属于本组织。',
  expired: '登录超时了，请再试一次。',
  unavailable: '连不上飞书，请再试一次。',
};

/**
 * Read as the page loads, before the workspace rewrites the address to its
 * own place (which drops it, so a reload starts clean); shown once.
 */
let pending = new URLSearchParams(window.location.search).get('signin');
/**
 * The place this page was opened at (a card's link, say), which signing in
 * returns to; read before the workspace rewrites the address.
 */
const opened = (() => {
  const query = new URLSearchParams(window.location.search);
  query.delete('signin');
  const search = query.toString();
  return window.location.pathname + (search ? '?' + search : '');
})();
const signIn =
  '/login' + (opened === '/' ? '' : '?next=' + encodeURIComponent(opened));
/** Opened inside the Feishu (Lark) client, whose sign-in asks nothing. */
const inFeishu = /\b(Lark|Feishu)\b/i.test(navigator.userAgent);
/** Set when a person signs out here, so the page doesn't sign them back in. */
export const SIGNED_OUT = 'kinmesh-signed-out';

/** `denied`: signed out here because the account lost its access. */
export function Auth({ denied = false }: { denied?: boolean }) {
  const [turned] = useState(() => {
    const value = pending === null ? undefined : turnedBack[pending];
    pending = null;
    return value;
  });
  const reason = denied ? '这个账号已无权访问此工作区。' : turned;
  // Inside Feishu the sign-in completes on its own, so it starts at once:
  // unless Feishu turned it back, access was lost, or you just signed out.
  const automatic = (() => {
    let chose = false;
    try {
      chose = sessionStorage.getItem(SIGNED_OUT) !== null;
    } catch {
      // Storage refused: sign in as asked.
    }
    return inFeishu && reason === undefined && !chose;
  })();
  useEffect(() => {
    if (automatic) window.location.replace(signIn);
  }, [automatic]);
  if (automatic) return null;
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
          一个团队，
          <br />
          一条长久的主线。
        </h1>
        <p>成员和智能体在同一处，对话、工作和决定都留在一起。</p>
      </section>
      <section className="auth-card">
        <h2>欢迎</h2>
        <a className="button" href={signIn}>
          使用飞书登录
        </a>
        {reason && <Notice>{reason}</Notice>}
      </section>
    </main>
  );
}
