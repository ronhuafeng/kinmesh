import { useEffect, useState } from 'react';
import { z } from 'zod';
import * as Tabs from '@radix-ui/react-tabs';
import { BootstrapInput, Credentials } from '../src/domain/contracts.js';
import { api, useAction, value } from './api.js';
import { Field, Notice } from './forms.js';
export function Auth({ onLogin }: { onLogin: () => void }) {
  const [tab, setTab] = useState('login');
  const [created, setCreated] = useState(false);
  // Setup is offered only while no team exists.
  const [setupOpen, setSetupOpen] = useState(true);
  useEffect(() => {
    void api('/api/setup/status')
      .then((raw) => {
        setSetupOpen(z.object({ open: z.boolean() }).parse(raw).open);
      })
      .catch(() => {
        // Unknown: keep offering setup; the server still refuses a second one.
      });
  }, []);
  const action = useAction();
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
        <Tabs.Root value={tab} onValueChange={setTab}>
          {setupOpen && (
            <Tabs.List aria-label="Account access">
              <Tabs.Trigger value="login">Sign in</Tabs.Trigger>
              <Tabs.Trigger value="setup">First owner setup</Tabs.Trigger>
            </Tabs.List>
          )}
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
              Run <code>npm run setup</code> on the server first. Paste its
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
                <Field label="Setup secret" hint="64 hex characters">
                  <input
                    name="setupToken"
                    type="password"
                    autoComplete="off"
                    required
                    pattern="[a-f0-9]{64}"
                  />
                </Field>
                <Field label="Owner username" hint="lowercase, 3–64 characters">
                  <input
                    name="username"
                    autoComplete="username"
                    required
                    pattern="[a-z0-9][a-z0-9_-]{2,63}"
                  />
                </Field>
                <Field label="Owner password" hint="at least 15 characters">
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
                  <input
                    name="teamName"
                    required
                    maxLength={80}
                    autoComplete="organization"
                  />
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
      </section>
    </main>
  );
}
