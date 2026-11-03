/** Bounded project API calls. Never log response bodies, URLs, keys or upstream errors. */
import type { AppConfig } from '../../shared/config.js';
import { transportProblem } from './tracing.js';

export class LangfuseApiError extends Error {
  constructor(readonly status: number | null) { super('Langfuse project API unavailable'); }
}
export function langfuseApi(cfg: AppConfig, fetcher: typeof fetch = fetch) {
  const { baseUrl, publicKey, secretKey } = cfg.tracing;
  if (!baseUrl || !publicKey || !secretKey || transportProblem(cfg, baseUrl)) throw new LangfuseApiError(null);
  const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
  return async (path: string, body?: object): Promise<unknown> => {
    try {
      const response = await fetcher(`${baseUrl.replace(/\/+$/, '')}/api/public/${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { authorization, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) { await response.body?.cancel(); throw new LangfuseApiError(response.status); }
      // A broken upstream must not allocate an unbounded response in the API process.
      const reader = response.body?.getReader();
      if (!reader) return null;
      const parts: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.length;
        if (bytes > 256 * 1024) { await reader.cancel(); throw new LangfuseApiError(null); }
        parts.push(value);
      }
      const text = Buffer.concat(parts).toString('utf8');
      return text ? JSON.parse(text) as unknown : null;
    } catch (error) { throw error instanceof LangfuseApiError ? error : new LangfuseApiError(null); }
  };
}
