import { useState } from 'react';
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

/** `denied`: signed out here because the account lost its access. */
export function Auth({ denied = false }: { denied?: boolean }) {
  const [turned] = useState(() => {
    const value = pending === null ? undefined : turnedBack[pending];
    pending = null;
    return value;
  });
  const reason = denied ? '这个账号已无权访问此工作区。' : turned;
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
        <a className="button" href="/login">
          使用飞书登录
        </a>
        {reason && <Notice>{reason}</Notice>}
      </section>
    </main>
  );
}
