/// <reference types="vite/client" />

/** The event stream `boot.ts` opened as the page started, until the app takes it. */
interface Window {
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
