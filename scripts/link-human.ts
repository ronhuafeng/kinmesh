import { z } from 'zod';
import { openStore } from '../src/persistence/store.js';
import { loadConfig } from '../src/server/config.js';
import { canonicalMailbox } from '../src/server/feishu.js';
// Ties a person who predates Feishu sign-in to their organization mailbox, so
// their next sign-in is them rather than someone new.
try {
  const config = loadConfig(process.env);
  const [username, mailbox] = z
    .tuple([z.string().min(3).max(64), z.string()])
    .parse(process.argv.slice(2));
  const email = canonicalMailbox(mailbox);
  if (email?.slice(email.lastIndexOf('@') + 1) !== config.feishu.emailDomain)
    throw new Error('Mailbox outside the organization');
  const store = openStore(config.database);
  try {
    store.linkMailbox(username, email);
  } finally {
    store.close();
  }
  console.info(`${username} now signs in as ${email}.`);
} catch {
  console.error(
    'Not linked. Usage: npm run link-human -- <username> <mailbox>; the person must exist, the mailbox must be in the organization domain and not taken.',
  );
  process.exitCode = 1;
}
