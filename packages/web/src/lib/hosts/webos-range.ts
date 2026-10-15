import { ReadError, type ByteReader } from '../subtitles/matroska';

/**
 * The app's own service on the TV (`packages/smart-tv/webos-service`). It reads
 * byte ranges outside the page, so a host that sends no CORS headers, as
 * debrid downloads often don't, can still be read.
 */
const SERVICE = 'luna://io.github.viren070.aiostreams.service/read';
/** Each answer crosses the TV's message bus as base64. */
const CHUNK = 512 * 1024;
const TIMEOUT_MS = 30_000;

interface PalmServiceBridge {
  onservicecallback: ((message: string) => void) | null;
  call(uri: string, parameters: string): void;
  cancel?(): void;
}

/** The service is missing or the bus refused the call, rather than the host failing. */
class NoService extends Error {}

/**
 * Throttling, a busy server and a dropped connection (0) pass. The rest of the
 * 4xx don't, nor a 200 that ignored the range.
 */
const lasting = (status: number) =>
  (status >= 200 && status < 300) ||
  (status >= 400 && status < 500 && status !== 408 && status !== 429);

function hostError(status: number, message: string, retryAfter?: unknown) {
  const seconds = Number(retryAfter);
  return new ReadError(
    message,
    lasting(status),
    seconds > 0 ? seconds * 1000 : 0
  );
}

function callService(
  parameters: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const Ctor = (window as { PalmServiceBridge?: new () => PalmServiceBridge })
    .PalmServiceBridge;
  if (typeof Ctor !== 'function')
    return Promise.reject(new NoService('No PalmServiceBridge'));
  return new Promise((resolve, reject) => {
    const bridge = new Ctor();
    const finish = () => {
      window.clearTimeout(timer);
      bridge.onservicecallback = null;
      bridge.cancel?.();
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(new ReadError('The TV service did not answer', false));
    }, TIMEOUT_MS);
    bridge.onservicecallback = (message) => {
      finish();
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(message) as Record<string, unknown>;
      } catch {
        reject(
          new ReadError('The TV service gave an unreadable answer', false)
        );
        return;
      }
      if (result.returnValue !== false) {
        resolve(result);
        return;
      }
      const reason = String(result.errorText ?? 'The TV service failed');
      reject(
        'httpStatus' in result
          ? hostError(Number(result.httpStatus) || 0, reason, result.retryAfter)
          : new NoService(reason)
      );
    };
    bridge.call(SERVICE, JSON.stringify(parameters));
  });
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchRange(
  url: string,
  headers: Record<string, string>,
  start: number,
  length: number
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { ...headers, Range: `bytes=${start}-${start + length - 1}` },
    });
  } catch (error) {
    throw new ReadError(String(error), false);
  }
  if (response.status !== 206 && !(response.status === 200 && start === 0)) {
    void response.body?.cancel();
    throw hostError(
      response.status,
      `The host answered ${response.status}`,
      response.headers.get('retry-after')
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < length) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
    }
  } catch (error) {
    // A host that cuts the body off still sent what came; the rest is asked for again.
    if (!got) throw new ReadError(String(error), false);
  }
  void reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(got, length));
  let at = 0;
  for (const part of parts) {
    out.set(part.subarray(0, out.length - at), at);
    at += part.length;
  }
  return out;
}

/** Reads `url` through the TV service, or the page's own fetch without one. */
export function webosRangeReader(
  url: string,
  headers: Record<string, string> = {}
): ByteReader {
  let service = true;
  return {
    async read(start, length) {
      const size = Math.min(length, CHUNK);
      if (service) {
        try {
          const result = await callService({
            url,
            headers,
            start,
            length: size,
          });
          return decodeBase64(String(result.data ?? ''));
        } catch (error) {
          if (!(error instanceof NoService)) throw error;
          service = false;
        }
      }
      return fetchRange(url, headers, start, size);
    },
  };
}
