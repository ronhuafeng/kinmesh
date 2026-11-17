import { asc, eq } from 'drizzle-orm';
import { filesText } from '../domain/attachments.js';
import type { Query } from './database.js';
import * as s from './schema.js';

/** A message's text, or for a message of files alone, their names. */
export async function messageText(db: Query, messageId: string, body: string) {
  if (body !== '') return body;
  const names = await db
    .select({ name: s.attachments.name })
    .from(s.attachments)
    .where(eq(s.attachments.messageId, messageId))
    .orderBy(asc(s.attachments.createdAt), asc(s.attachments.id));
  return filesText(names.map((row) => row.name));
}
