import { EventEmitter } from 'node:events';

/** Keep listeners installed until the runner has drained its child and closed the locks. */
export function releaseSignals() {
  const graceful = new AbortController(), forced = new AbortController();
  return {
    signal: graceful.signal,
    forceSignal: forced.signal,
    stop() {
      if (graceful.signal.aborted) forced.abort();
      else graceful.abort();
    },
  };
}

export function installReleaseSignals(control: ReturnType<typeof releaseSignals>, source: EventEmitter = process): () => void {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const stop = () => control.stop();
  for (const signal of signals) source.on(signal, stop);
  return () => { for (const signal of signals) source.removeListener(signal, stop); };
}
