/// <reference types="vite/client" />

/** The event stream `boot.ts` opened as the page started, until the app takes it. */
/** Chrome's offer to install the app, kept for 安装 (`boot.ts`). */
interface InstallOffer extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
interface Window {
  kinmeshInstall?: InstallOffer | null;
  kinmeshStream?: {
    /** The stream's query: the place it watches. */
    query: string;
    source: EventSource;
    /** Events that arrived before the app took the stream, in order. */
    early: MessageEvent[];
    /** Whether it failed before the app took it. */
    failed: boolean;
    /** Stops keeping events: the app listens from here on. */
    release: () => void;
  };
}
