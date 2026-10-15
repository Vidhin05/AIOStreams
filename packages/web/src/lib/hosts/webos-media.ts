/**
 * LG's player leaves `video.textTracks` empty, so a file's own subtitles never
 * reach the page. The media pipeline that plays the `<video>` lists them and
 * can show one; `PalmServiceBridge` is what the TV injects to talk to it.
 */

export interface WebosTextInfo {
  language?: string;
  title?: string;
  codec?: string;
}

export interface WebosTextPipeline {
  watch(onTracks: (tracks: WebosTextInfo[]) => void): void;
  /** An index from `watch`, or null for none. */
  show(index: number | null): void;
  /** A seek drops the subtitle the pipeline was showing. */
  reapply(): void;
  close(): void;
}

interface PalmServiceBridge {
  onservicecallback: ((message: string) => void) | null;
  call(uri: string, parameters: string): void;
  cancel?(): void;
}

interface WebOSVideo extends HTMLVideoElement {
  mediaId?: string | number;
}

const POLL_MS = 300;
const POLL_FOR_MS = 15_000;
const SELECT_DELAY_MS = 400;

function bridgeCtor(): (new () => PalmServiceBridge) | null {
  const ctor = (window as { PalmServiceBridge?: new () => PalmServiceBridge })
    .PalmServiceBridge;
  return typeof ctor === 'function' ? ctor : null;
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (!text || text === '(null)' || /^(und|unknown)$/i.test(text)) return;
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

/** The pipeline's subtitle rows, or null when this message is not that list. */
function textTracksOf(result: Record<string, unknown>): WebosTextInfo[] | null {
  const source = asRecord(result.sourceInfo);
  if (!source) return null;
  const info = source.programInfo;
  const program = Array.isArray(info) ? asRecord(info[0]) : asRecord(info);
  if (!program) return [];
  const raw = program.subtitleTrackInfo;
  if (!Array.isArray(raw)) return [];
  return raw.map((track) => {
    const row = asRecord(track) ?? {};
    return {
      language: clean(row.language),
      title: clean(row.title) ?? clean(row.description),
      codec: clean(row.codec),
    };
  });
}

function mediaIdOf(video: HTMLVideoElement): string | null {
  const id = (video as WebOSVideo).mediaId;
  if (id === undefined || id === null || id === '') return null;
  return String(id);
}

/**
 * The TV's media pipeline for `video`, or null away from webOS. `watch` runs
 * once the pipeline reports its subtitle tracks.
 */
export function webosTextPipeline(
  video: HTMLVideoElement
): WebosTextPipeline | null {
  const Ctor = bridgeCtor();
  if (!Ctor) return null;

  let mediaId: string | null = null;
  let wanted: number | null | undefined;
  let closed = false;
  let reported = false;
  let selectTimer = 0;
  let pollTimer = 0;
  const bridges: PalmServiceBridge[] = [];

  const drop = (bridge: PalmServiceBridge) => {
    bridge.onservicecallback = null;
    bridge.cancel?.();
    const at = bridges.indexOf(bridge);
    if (at >= 0) bridges.splice(at, 1);
  };

  const luna = (
    method: string,
    parameters: Record<string, unknown>,
    onSuccess?: (result: Record<string, unknown>) => void,
    onFailure?: () => void
  ): PalmServiceBridge | null => {
    if (closed) return null;
    const bridge = new Ctor();
    bridges.push(bridge);
    const subscribed = parameters.subscribe === true;
    bridge.onservicecallback = (message) => {
      let result: Record<string, unknown> | null = null;
      try {
        result = asRecord(JSON.parse(message) as unknown);
      } catch {
        result = null;
      }
      if (!result || result.errorCode) {
        if (!subscribed) drop(bridge);
        onFailure?.();
        return;
      }
      onSuccess?.(result);
      if (!subscribed) drop(bridge);
    };
    bridge.call(`luna://com.webos.media/${method}`, JSON.stringify(parameters));
    return bridge;
  };

  const apply = (index: number | null) => {
    if (!mediaId || closed) return;
    window.clearTimeout(selectTimer);
    if (index === null) {
      luna('setSubtitleEnable', { mediaId, enable: false });
      return;
    }
    luna('setSubtitleEnable', { mediaId, enable: true });
    selectTimer = window.setTimeout(() => {
      if (closed || wanted !== index || !mediaId) return;
      const id = mediaId;
      // `text` is the type current TVs select; older ones say `subtitle`.
      luna('selectTrack', { mediaId: id, type: 'text', index }, undefined, () =>
        luna('selectTrack', { mediaId: id, type: 'subtitle', index })
      );
    }, SELECT_DELAY_MS);
  };

  const subscribe = (onTracks: (tracks: WebosTextInfo[]) => void) => {
    if (!mediaId) return;
    luna('subscribe', { mediaId, subscribe: true }, (result) => {
      const tracks = textTracksOf(result);
      if (!tracks || reported || closed || !tracks.length) return;
      reported = true;
      onTracks(tracks);
    });
  };

  return {
    watch(onTracks) {
      const started = Date.now();
      const search = () => {
        if (closed || mediaId) return;
        const id = mediaIdOf(video);
        if (!id) {
          if (Date.now() - started < POLL_FOR_MS)
            pollTimer = window.setTimeout(search, POLL_MS);
          return;
        }
        mediaId = id;
        if (wanted !== undefined) apply(wanted);
        subscribe(onTracks);
      };
      search();
    },
    show(index) {
      wanted = index;
      apply(index);
    },
    reapply() {
      if (wanted === undefined) return;
      apply(wanted);
    },
    close() {
      closed = true;
      window.clearTimeout(selectTimer);
      window.clearTimeout(pollTimer);
      for (const bridge of bridges) {
        bridge.onservicecallback = null;
        bridge.cancel?.();
      }
      bridges.length = 0;
    },
  };
}
