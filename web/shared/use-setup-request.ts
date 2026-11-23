import { useRequest } from './use-request.js';

/** A setup request; a conflict means the page is behind what changed. */
export const useSetupRequest = () =>
  useRequest({ 409: '这已不适用，面板显示了变化。' });
