import { webosRangeReader } from '../hosts/webos-range';
import { parseAssCues, type SubtitleCue } from '../subtitles/cues';
import { assRenderer, type AssRenderer } from '../subtitles/libass';
import {
  AttachedFonts,
  assScript,
  openMatroska,
  scriptFamilies,
  SideReader,
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
/**
 * libass parses the whole script on each change, so it gets the events around
 * the playhead, not the track: a karaoke opening alone can be megabytes.
 */
const SCRIPT_BEHIND_MS = 30_000;
const SCRIPT_AHEAD_MS = 120_000;
const SCRIPT_EVENTS = 15_000;
/** The script is redrawn once the playhead is this near its end. */
const REDRAW_BEFORE_MS = 30_000;

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
  /** A track the TV took back for a failed read is readable again. */
  onBack(ordinal: number, drawer: Drawer): void;
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

/** The video buffered past the playhead, or null where the TV reports none. */
function bufferedAhead(video: HTMLVideoElement): number | null {
  const { buffered, currentTime } = video;
  if (!buffered.length) return null;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i))
      return (buffered.end(i) - currentTime) * 1000;
  }
  return 0;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function webosSubtitles(options: Options): WebosSubtitles {
  const { video } = options;
  const reader = new SideReader(webosRangeReader(options.url, options.headers));
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
  let scriptFrom = 0;
  let scriptTo = 0;
  let schedule = () => {};

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
      harvest = new SubtitleHarvest(
        opened,
        opened.subtitles[ordinal],
        () => reader.lanes
      );
      harvests.set(ordinal, harvest);
    }
    return harvest;
  };

  /** The events libass gets now: those on screen around the playhead, nearest first when there are too many. */
  const scriptEvents = (events: Iterable<HarvestedEvent>) => {
    scriptFrom = positionMs - SCRIPT_BEHIND_MS;
    scriptTo = positionMs + SCRIPT_AHEAD_MS;
    let shown: HarvestedEvent[] = [];
    for (const event of events)
      if (event.endMs >= scriptFrom && event.startMs <= scriptTo)
        shown.push(event);
    if (shown.length <= SCRIPT_EVENTS) return shown;
    scriptFrom = positionMs;
    shown = shown
      .filter((event) => event.endMs >= positionMs)
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, SCRIPT_EVENTS);
    scriptTo = shown[shown.length - 1]?.startMs ?? positionMs;
    return shown;
  };

  const stop = () => {
    for (const harvest of harvests.values()) harvest.pause();
    current = null;
    window.clearTimeout(drawTimer);
    drawTimer = 0;
    schedule = () => {};
    void renderer?.then((started) => started?.clear());
  };

  return {
    async prepare(startMs) {
      positionMs = startMs;
      reader.setPlaying(false);
      const ready = (async () => {
        const opened = await open();
        if (!opened || closed) return;
        const ordinal = likelyTrack(opened);
        if (ordinal < 0) return;
        const track = opened.subtitles[ordinal];
        const harvest = harvestOf(opened, ordinal);
        harvest.start(startMs);
        // The page draws a text track's first line as soon as it is read.
        if (track.kind !== 'ass') return;
        await Promise.all([
          harvest.settled(startMs + PREFETCH_AHEAD_MS),
          loadFonts(scriptFamilies(track.header)),
        ]);
      })();
      await Promise.race([ready.catch(() => {}), sleep(PREFETCH_MS)]);
      reader.setPlaying(true);
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
      const drawer: Drawer = started ? 'libass' : 'page';
      const harvest = harvestOf(opened, ordinal);
      current = harvest;
      let lost = false;
      const draw = () => {
        if (current !== harvest) return;
        drawnAt = Date.now();
        if (lost && harvest.events.size) {
          lost = false;
          options.onBack(ordinal, drawer);
        }
        if (track.kind === 'text') {
          scriptFrom = -Infinity;
          scriptTo = Infinity;
          options.onCues(textCues(Array.from(harvest.events.values())));
          return;
        }
        const script = assScript(track, scriptEvents(harvest.events.values()));
        if (!started) {
          options.onCues(parseAssCues(script));
          return;
        }
        started.show(script);
        void loadFonts(scriptFamilies(script));
      };
      schedule = () => {
        if (current !== harvest || drawTimer) return;
        const wait = Math.max(0, drawnAt + DRAW_EVERY_MS - Date.now());
        drawTimer = window.setTimeout(() => {
          drawTimer = 0;
          draw();
        }, wait);
      };
      harvest.onUpdate = (event) => {
        // Reading the rest of the file in the background changes nothing on screen.
        if (
          track.kind === 'ass' &&
          !lost &&
          (event.endMs < scriptFrom || event.startMs > scriptTo)
        )
          return;
        schedule();
      };
      harvest.onFail = (_error, lasting) => {
        if (current !== harvest || lost) return;
        lost = true;
        // A passing failure keeps reading, and the track comes back once a read works.
        if (lasting) stop();
        options.onLost(ordinal);
      };
      draw();
      harvest.setBuffered(bufferedAhead(video));
      harvest.start(positionMs);
      return drawer;
    },

    hide() {
      token++;
      stop();
    },

    setPosition(ms) {
      positionMs = ms;
      if (!current) return;
      current.setBuffered(bufferedAhead(video));
      current.setPosition(ms);
      if (ms < scriptFrom || ms > scriptTo - REDRAW_BEFORE_MS) schedule();
    },

    setDelay(ms) {
      delayMs = ms;
      void renderer?.then((started) => started?.setDelay(ms));
    },

    close() {
      closed = true;
      token++;
      stop();
      reader.close();
      void renderer?.then((started) => started?.destroy());
    },
  };
}
