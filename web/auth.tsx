import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { BootstrapInput, Credentials } from '../src/domain/contracts.js';
import { useAction, value } from './api.js';
import { Field, Notice } from './forms.js';
export function Auth({ onLogin }: { onLogin: () => void }) {
  const [tab, setTab] = useState('login');
  const [created, setCreated] = useState(false);
  const action = useAction();
  return (
    <main className="auth-shell">
      <section className="auth-intro">
        <a className="brand" href="/">
          k<span>kinmesh</span>
        </a>
        <p className="eyebrow">A shared place for thoughtful work</p>
        <h1>
          One team.
          <br />A lasting thread.
        </h1>
        <p>
          Bring people and persistent agents together. Keep the conversation,
          responsibility, and decisions connected.
        </p>
        <div className="intro-note">
          Conversations stay with your team.
          <br />
          Final acceptance stays with a human.
        </div>
      </section>
      <section className="auth-card">
        <Tabs.Root value={tab} onValueChange={setTab}>
          <Tabs.List aria-label="Account access">
            <Tabs.Trigger value="login">Sign in</Tabs.Trigger>
            <Tabs.Trigger value="setup">First owner setup</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="login">
            <h2>Welcome back</h2>
            <p>Sign in to your team workspace.</p>
            {created && (
              <p role="status">
                Owner created. Sign in with your new credentials.
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                try {
                  const data = Credentials.parse({
                    username: value(new FormData(form), 'username'),
                    password: value(new FormData(form), 'password'),
                  });
                  void action.send('/api/login', data, false, {}, () => {
                    form.reset();
                    onLogin();
                  });
                } catch {
                  action.invalid();
                }
              }}
            >
              <fieldset disabled={action.busy || action.uncertain}>
                <Field label="Username">
                  <input
                    name="username"
                    autoComplete="username"
                    required
                    minLength={3}
                    maxLength={64}
                  />
                </Field>
                <Field label="Password">
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={15}
                    maxLength={128}
                  />
                </Field>
                <button type="submit">Sign in</button>
              </fieldset>
            </form>
          </Tabs.Content>
          <Tabs.Content value="setup">
            <h2>Start your team</h2>
            <p>
              Run <code>npm run setup</code> on the server first. Use its
              private one-time setup secret here. Setup does not sign you in.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const f = new FormData(form);
                try {
                  const data = BootstrapInput.parse({
                    username: value(f, 'username'),
                    password: value(f, 'password'),
                    teamName: value(f, 'teamName'),
                  });
                  const token = value(f, 'setupToken');
                  void action.send(
                    '/api/setup',
                    data,
                    false,
                    {
                      authorization: `Bearer ${token}`,
                    },
                    () => {
                      form.reset();
                      setCreated(true);
                      setTab('login');
                    },
                  );
                } catch {
                  action.invalid();
                }
              }}
            >
              <fieldset disabled={action.busy || action.uncertain}>
                <Field label="Setup secret">
                  <input
                    name="setupToken"
                    type="password"
                    autoComplete="off"
                    required
                    pattern="[a-f0-9]{64}"
                  />
                </Field>
                <Field label="Owner username">
                  <input
                    name="username"
                    autoComplete="username"
                    required
                    pattern="[a-z0-9][a-z0-9_-]{2,63}"
                  />
                </Field>
                <Field label="Owner password">
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={15}
                    maxLength={128}
                  />
                </Field>
                <Field label="Team name">
                  <input name="teamName" required maxLength={80} />
                </Field>
                <button type="submit">Create owner and team</button>
              </fieldset>
            </form>
          </Tabs.Content>
        </Tabs.Root>
        {action.error && <Notice>{action.error}</Notice>}
        {action.uncertain && (
          <button
            disabled={action.busy}
            onClick={() => {
              void action.retry();
            }}
          >
            Retry same action
          </button>
        )}
        <p className="privacy-note">
          Your session uses a protected cookie. No provider credentials are
          required.
        </p>
      </section>
    </main>
  );
}
