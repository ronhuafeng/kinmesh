import { z } from 'zod';
import { Author, CorrelationInput } from './agents.js';
import { MessageId } from './communication.js';
import { PullRequestRef } from './pull-requests.js';

/** The most pieces of proof one criterion carries. */
export const PROOF_PIECES_MOST = 5;
const Words = z.string().trim().min(1).max(500);
const Address = z.url({ protocol: /^https$/ }).max(2000);

/**
 * One piece of proof the owner cites when it asks for review: a pull
 * request or T3 run already linked to the task, a message in its channel,
 * or an address, which is only the owner's word.
 */
export const ProofCite = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pull-request'),
    pullRequest: PullRequestRef,
  }),
  z.strictObject({ kind: z.literal('run'), executionId: z.uuid() }),
  z.strictObject({ kind: z.literal('message'), messageId: MessageId }),
  z.strictObject({ kind: z.literal('link'), url: Address }),
]);
export type ProofCite = z.infer<typeof ProofCite>;

/**
 * What the owner offers for its criteria when it asks for review: per
 * criterion, by its position in the task's criteria, its words about it
 * and what proves it.
 */
export const ProofInput = z
  .array(
    z
      .strictObject({
        criterion: z.number().int().min(0).max(19),
        words: Words.optional(),
        pieces: z.array(ProofCite).max(PROOF_PIECES_MOST).optional(),
      })
      .refine((c) => c.words !== undefined || (c.pieces ?? []).length > 0),
  )
  .min(1)
  .max(20)
  .refine((v) => new Set(v.map((c) => c.criterion)).size === v.length);
export type ProofInput = z.input<typeof ProofInput>;

/** A cited piece as kept: what it was when the owner cited it. */
export const ProofPiece = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pull-request'),
    pullRequest: PullRequestRef,
  }),
  z.strictObject({
    kind: z.literal('run'),
    executionId: z.uuid(),
    reference: CorrelationInput.shape.reference,
    linkedAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('message'),
    messageId: MessageId,
    author: Author,
    sentAt: z.iso.datetime(),
  }),
  z.strictObject({ kind: z.literal('link'), url: Address }),
]);
export type ProofPiece = z.infer<typeof ProofPiece>;

/**
 * One round of proof: what the owner offered for each criterion the last
 * time it asked for review, kept as it was given. The next request for
 * review replaces it; the task's history keeps every round.
 */
export const TaskProof = z.strictObject({
  author: Author,
  givenAt: z.iso.datetime(),
  criteria: z
    .array(
      z.strictObject({
        /** The criterion's text when it was cited. */
        criterion: z.string(),
        words: Words.nullable(),
        pieces: z.array(ProofPiece).max(PROOF_PIECES_MOST),
      }),
    )
    .max(20),
});
export type TaskProof = z.infer<typeof TaskProof>;
