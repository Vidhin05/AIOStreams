import { webosRangeReader } from '../hosts/webos-range';
import { parseAssCues, type SubtitleCue } from '../subtitles/cues';
import { assRenderer, type AssRenderer } from '../subtitles/libass';
import {
  AttachedFonts,
  assScript,
  openMatroska,
  scriptFamilies,
  SubtitleHarvest,
  type HarvestedEvent,
  type MkvFile,
} from '../subtitles/matroska';

/**
 * LG's player draws one event of a file's own ASS track, without its place,
 * colours or fonts. The page reads the track out of the file itself and libass
 * draws it; a plain-text track goes to the page's own lines.
 */

/** Some hosts cut ranges short while the TV streams the same file, so the index comes first. */
const PREFETCH_MS = 4000;
const PREFETCH_AHEAD_MS = 30_000;
const DRAW_EVERY_MS = 1000;

const TAGS = /<[^>]*>|\{[^}]*\}/g;

export type Drawer = 'libass' | 'page';

export interface WebosSubtitles {
  /** Reads the file's index and its likeliest track's opening before the video starts. */
  prepare(startMs: number): Promise<void>;
  /** Draws a whole script with libass; false when this TV can't run it. */
  showScript(script: string): Promise<boolean>;
  /** Draws the file's own track `ordinal`, or null when the TV should. */
  showEmbedded(ordinal: number): Promise<Drawer | null>;
  hide(): void;
  /** The file's time the subtitles are at, delay taken off. */
  setPosition(ms: number): void;
  setDelay(ms: number): void;
  close(): void;
}

interface Options {
  video: HTMLVideoElement;
  url: string;
  headers?: Record<string, string>;
  delayMs: number;
  /** The lines of an embedded track the page draws. */
  onCues(cues: SubtitleCue[]): void;
  /** The embedded track being drawn could not be read, so the TV takes it back. */
  onLost(ordinal: number): void;
}

function textCues(events: HarvestedEvent[]): SubtitleCue[] {
  return events
    .map((event) => ({
      startMs: event.startMs,
      endMs: event.endMs,
      text: event.text.replace(/\r/g, '').replace(TAGS, '').trim(),
    }))
    .filter((cue) => cue.text)
    .sort((a, b) => a.startMs - b.startMs);
}

/** The track the player most likely picks: the first marked default, or the first ASS one. */
function likelyTrack(file: MkvFile): number {
  const { subtitles } = file;
  const marked = subtitles.findIndex((track) => track.kind && track.isDefault);
  if (marked >= 0) return marked;
  const ass = subtitles.findIndex((track) => track.kind === 'ass');
  return ass >= 0 ? ass : subtitles.findIndex((track) => track.kind);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function webosSubtitles(options: Options): WebosSubtitles {
  const { video } = options;
  const reader = webosRangeReader(options.url, options.headers);
  let delayMs = options.delayMs;
  let closed = false;
  let token = 0;
  let positionMs = 0;
  let file: Promise<MkvFile | null> | null = null;
  let fonts: AttachedFonts | null = null;
  let renderer: Promise<AssRenderer | null> | null = null;
  // Fonts read before libass started.
  const waitingFonts: Uint8Array[] = [];
  const harvests = new Map<number, SubtitleHarvest>();
  let current: SubtitleHarvest | null = null;
  let drawTimer = 0;
  let drawnAt = 0;

  const open = () =>
    (file ??= openMatroska(reader)
      .then((opened) => {
        if (opened) fonts = new AttachedFonts(opened);
        return opened;
      })
      .catch(() => null));

  const libass = () =>
    (renderer ??= assRenderer(video, delayMs)
      .then((started) => {
        for (const font of waitingFonts.splice(0)) started.addFont(font);
        if (closed) started.destroy();
        return started;
      })
      .catch(() => null));

  const loadFonts = async (families: Set<string>) => {
    if (!fonts || !families.size) return;
    const loaded = await fonts.take(families);
    if (!loaded.length) return;
    const started = renderer && (await renderer);
    if (started) for (const font of loaded) started.addFont(font);
    else if (!renderer) waitingFonts.push(...loaded);
  };

  const harvestOf = (opened: MkvFile, ordinal: number) => {
    let harvest = harvests.get(ordinal);
    if (!harvest) {
      harvest = new SubtitleHarvest(opened, opened.subtitles[ordinal]);
      harvests.set(ordinal, harvest);
    }
    return harvest;
  };

  const stop = () => {
    for (const harvest of harvests.values()) harvest.pause();
    current = null;
    window.clearTimeout(drawTimer);
    drawTimer = 0;
    void renderer?.then((started) => started?.clear());
  };

  return {
    async prepare(startMs) {
      positionMs = startMs;
      const ready = (async () => {
        const opened = await open();
        if (!opened || closed) return;
        const ordinal = likelyTrack(opened);
        if (ordinal < 0) return;
        const track = opened.subtitles[ordinal];
        const harvest = harvestOf(opened, ordinal);
        harvest.start(startMs);
        await Promise.all([
          harvest.settled(startMs + PREFETCH_AHEAD_MS),
          track.kind === 'ass' ? loadFonts(scriptFamilies(track.header)) : null,
        ]);
      })();
      await Promise.race([ready.catch(() => {}), sleep(PREFETCH_MS)]);
    },

    async showScript(script) {
      const mine = ++token;
      stop();
      const started = await libass();
      if (!started || mine !== token || closed) return false;
      started.show(script);
      return true;
    },

    async showEmbedded(ordinal) {
      const mine = ++token;
      stop();
      const opened = await open();
      const track = opened?.subtitles[ordinal];
      if (!opened || !track?.kind || mine !== token || closed) return null;
      const started = track.kind === 'ass' ? await libass() : null;
      if (mine !== token || closed) return null;
      const harvest = harvestOf(opened, ordinal);
      current = harvest;
      const draw = () => {
        if (current !== harvest) return;
        drawnAt = Date.now();
        const events = Array.from(harvest.events.values());
        if (track.kind === 'text') {
          options.onCues(textCues(events));
          return;
        }
        const script = assScript(track, events);
        if (!started) {
          options.onCues(parseAssCues(script));
          return;
        }
        started.show(script);
        void loadFonts(scriptFamilies(script));
      };
      harvest.onUpdate = () => {
        if (current !== harvest || drawTimer) return;
        const wait = Math.max(0, drawnAt + DRAW_EVERY_MS - Date.now());
        drawTimer = window.setTimeout(() => {
          drawTimer = 0;
          draw();
        }, wait);
      };
      harvest.onFail = () => {
        if (current !== harvest) return;
        stop();
        options.onLost(ordinal);
      };
      draw();
      harvest.start(positionMs);
      return started ? 'libass' : 'page';
    },

    hide() {
      token++;
      stop();
    },

    setPosition(ms) {
      positionMs = ms;
      current?.setPosition(ms);
    },

    setDelay(ms) {
      delayMs = ms;
      void renderer?.then((started) => started?.setDelay(ms));
    },

    close() {
      closed = true;
      token++;
      stop();
      void renderer?.then((started) => started?.destroy());
    },
  };
}
