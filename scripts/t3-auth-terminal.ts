import { openSync, constants } from 'node:fs';
import { WriteStream } from 'node:tty';
import { password } from '@inquirer/prompts';
import {
  callbackCode,
  type AuthorizationInteraction,
} from '../src/adapters/t3/authorization.js';

export function requireManualTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY)
    throw new Error('Private interactive terminal required');
}

/** Explicit owner-run mode only. Never call from an agent tool/CI session or recorded terminal. */
export function manualTerminal() {
  requireManualTerminal();
  const fd = openSync('/dev/tty', constants.O_WRONLY | constants.O_NOCTTY);
  const terminal = new WriteStream(fd);
  const displayed = Promise.withResolvers<undefined>();
  const interaction: AuthorizationInteraction = {
    prepare(state, issuer, signal) {
      const code = (async () => {
        await displayed.promise;
        signal.throwIfAborted();
        const input = await password(
          {
            message:
              'Paste the FINAL localhost redirect URL here (hidden; Enter once):',
            mask: false,
            toggleMask: false,
          },
          {
            input: process.stdin,
            output: terminal,
            signal,
            clearPromptOnDone: true,
          },
        );
        return callbackCode(input, state, issuer);
      })();
      return Promise.resolve({ code });
    },
    async redirect(url, signal) {
      signal.throwIfAborted();
      await new Promise<void>((done, reject) => {
        terminal.write(
          '\nOpen this one-time URL only in your trusted browser. Approve in T3; choose Supervised, NEVER Full access.\n' +
            'After approval, immediately copy the complete failed-localhost redirect URL back to the hidden prompt. Codes expire after 60 seconds.\n' +
            url.href +
            '\n\n',
          (error) => {
            if (error) reject(new Error('Private terminal unavailable'));
            else done();
          },
        );
      });
      displayed.resolve(undefined);
    },
  };
  return {
    interaction,
    close() {
      terminal.destroy();
    },
  };
}
