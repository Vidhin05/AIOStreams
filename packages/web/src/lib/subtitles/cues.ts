export interface SubtitleLine {
  startMs: number;
  text: string;
}

const TIMING =
  /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function toMs(stamp: string): number {
  const [clock, fraction = '0'] = stamp.replace(',', '.').split('.');
  const parts = clock.split(':').map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3));
}

export interface SubtitleCue extends SubtitleLine {
  endMs: number;
  /** Where an ASS line sits. Absent for a plain caption. */
  place?: SubtitlePlace;
}

/** ASS numpad anchor, and `\pos` as a percent of the script's frame. */
export interface SubtitlePlace {
  anchor: number;
  x?: number;
  y?: number;
}

/** One line the page draws, already chosen for this moment. */
export interface PlacedSubtitle {
  text: string;
  anchor: number;
  x?: number;
  y?: number;
}

const TAGS = /<[^>]*>|\{[^}]*\}/g;

/** The cues of a WebVTT or SRT file, markup kept. */
export function parseCues(body: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of body.replace(/\r/g, '').split(/\n{2,}/)) {
    const rows = block.split('\n');
    const at = rows.findIndex((row) => TIMING.test(row));
    if (at < 0) continue;
    const text = rows
      .slice(at + 1)
      .join('\n')
      .trim();
    const [, start, end] = TIMING.exec(rows[at])!;
    if (text) cues.push({ startMs: toMs(start), endMs: toMs(end), text });
  }
  return cues;
}

function anchorOf(raw: string, styleAnchor: number): SubtitlePlace {
  const an = /\\an([1-9])/.exec(raw);
  const pos = /\\pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(raw);
  const place: SubtitlePlace = {
    anchor: an ? Number(an[1]) : styleAnchor,
  };
  return pos ? { ...place, x: Number(pos[1]), y: Number(pos[2]) } : place;
}

/**
 * The dialogue of an ASS or SSA file. Drawings are dropped. A sign keeps the
 * anchor and position the script gave it; colours and fonts do not.
 */
export function parseAssCues(body: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let section = '';
  let playResX = 384;
  let playResY = 288;
  let eventFields: string[] = [];
  let styleFields: string[] = [];
  const styleAnchor = new Map<string, number>();
  for (const row of body.replace(/\r/g, '').split('\n')) {
    const line = row.trim();
    if (!line || line.startsWith(';') || line.startsWith('!:')) continue;
    if (line.startsWith('[')) {
      section = line.toLowerCase();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const rest = line.slice(colon + 1).trim();
    if (section === '[script info]') {
      const size = Number(rest);
      if (key === 'playresx' && size > 0) playResX = size;
      if (key === 'playresy' && size > 0) playResY = size;
      continue;
    }
    if (section === '[v4+ styles]' || section === '[v4 styles]') {
      const values = rest.split(',');
      if (key === 'format')
        styleFields = values.map((field) => field.trim().toLowerCase());
      if (key === 'style' && styleFields.length) {
        const at = (name: string) =>
          values[styleFields.indexOf(name)]?.trim() ?? '';
        const anchor = Number(at('alignment'));
        const name = at('name').toLowerCase();
        if (name && anchor >= 1 && anchor <= 9) styleAnchor.set(name, anchor);
      }
      continue;
    }
    if (section !== '[events]') continue;
    const values = rest.split(',');
    if (key === 'format') {
      eventFields = values.map((field) => field.trim().toLowerCase());
      continue;
    }
    if (key !== 'dialogue' || !eventFields.includes('text')) continue;
    const field = (name: string) =>
      values[eventFields.indexOf(name)]?.trim() ?? '';
    const raw = values.slice(eventFields.indexOf('text')).join(',');
    if (/\{[^}]*\\p[1-9]/.test(raw)) continue;
    const text = raw
      .replace(TAGS, '')
      .replace(/\\n/gi, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    if (!text) continue;
    const place = anchorOf(raw, styleAnchor.get(field('style').toLowerCase()) ?? 2);
    if (place.x !== undefined && place.y !== undefined) {
      place.x = (place.x / playResX) * 100;
      place.y = (place.y / playResY) * 100;
    }
    cues.push({
      startMs: toMs(field('start')),
      endMs: toMs(field('end')),
      text,
      place,
    });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** The lines of a WebVTT or SRT file, tags stripped. */
export function parseSubtitleLines(body: string): SubtitleLine[] {
  return parseCues(body).flatMap(({ startMs, text }) => {
    const plain = text.replace(/\n/g, ' ').replace(TAGS, '').trim();
    return plain ? [{ startMs, text: plain }] : [];
  });
}
