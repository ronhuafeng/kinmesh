import { z } from 'zod';
export const TaskStatus = z.enum([
  'proposed',
  'in-progress',
  'review-requested',
  'awaiting-human',
  'rework-requested',
  'accepted',
  'cancelled',
]);
export const TaskAction = z.enum([
  'create',
  'claim',
  'progress',
  'handoff',
  'request-review',
  'review',
  'accept',
  'rework',
  'cancel',
  'link-execution',
]);
