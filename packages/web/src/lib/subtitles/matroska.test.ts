import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  assScript,
  openMatroska,
  scriptFamilies,
  SubtitleHarvest,
  type ByteReader,
} from './matroska';

(globalThis as { window?: unknown }).window ??= globalThis;

const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1
Style: Sign,Gandhi Sans,40,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const idBytes = (id: number) => {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return Uint8Array.from(out);
};

/** Always eight bytes, so sizes and positions never move what follows. */
const size = (n: number) => {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  for (let i = 7, v = n; i > 0; i--, v = Math.floor(v / 256)) out[i] = v % 256;
  return out;
};

const el = (id: number, ...data: Uint8Array[]) => {
  const body = join(...data);
  return join(idBytes(id), size(body.length), body);
};

const uint = (n: number, length = 8) => {
  const out = new Uint8Array(length);
  for (let i = length - 1, v = n; i >= 0; i--, v = Math.floor(v / 256))
    out[i] = v % 256;
  return out;
};

const str = (text: string) => new TextEncoder().encode(text);

/** A block: track number, timestamp relative to the cluster, flags, payload. */
const block = (track: number, relative: number, payload: Uint8Array) =>
  join(
    Uint8Array.of(0x80 | track),
    uint(relative, 2),
    Uint8Array.of(0),
    payload
  );

const group = (
  track: number,
  relative: number,
  duration: number,
  payload: Uint8Array
) =>
  el(0xa0, el(0xa1, block(track, relative, payload)), el(0x9b, uint(duration)));

function file(): Uint8Array {
  const tracks = el(
    0x1654ae6b,
    el(
      0xae,
      el(0xd7, uint(1)),
      el(0x83, uint(1)),
      el(0x86, str('V_MPEG4/ISO/AVC'))
    ),
    el(
      0xae,
      el(0xd7, uint(2)),
      el(0x83, uint(0x11)),
      el(0x86, str('S_TEXT/ASS')),
      el(0x63a2, str(HEADER))
    ),
    el(
      0xae,
      el(0xd7, uint(3)),
      el(0x83, uint(0x11)),
      el(0x86, str('S_TEXT/UTF8')),
      el(
        0x6d80,
        el(0x6240, el(0x5032, uint(1)), el(0x5034, el(0x4254, uint(0))))
      )
    )
  );
  const info = el(0x1549a966, el(0x2ad7b1, uint(1_000_000)));
  const video = el(0xa3, block(1, 0, new Uint8Array(3000)));
  const hello = group(2, 1000, 2000, str('0,0,Default,,0,0,0,,Hello'));
  const sign = group(2, 1000, 2000, str('1,0,Sign,,0,0,0,,{\\an8}On the door'));
  const plain = group(3, 1500, 1000, deflateSync(str('<i>Plain line</i>')));
  const first = [el(0xe7, uint(0)), video, hello, sign, plain];
  const later = group(2, 0, 1500, str('2,0,Default,,0,0,0,,Later'));
  const second = [el(0xe7, uint(5000)), later];
  const cluster1 = el(0x1f43b675, ...first);
  const cluster2 = el(0x1f43b675, ...second);
  const relative = (parts: Uint8Array[], index: number) =>
    parts.slice(0, index).reduce((n, p) => n + p.length, 0);
  const seekHead = (tracksAt: number, cuesAt: number) =>
    el(
      0x114d9b74,
      el(0x4dbb, el(0x53ab, idBytes(0x1654ae6b)), el(0x53ac, uint(tracksAt))),
      el(0x4dbb, el(0x53ab, idBytes(0x1c53bb6b)), el(0x53ac, uint(cuesAt)))
    );
  const headLength = seekHead(0, 0).length;
  const tracksAt = headLength + info.length;
  const cluster1At = tracksAt + tracks.length;
  const cluster2At = cluster1At + cluster1.length;
  const cuesAt = cluster2At + cluster2.length;
  const cue = (time: number, track: number, cluster: number, rel?: number) =>
    el(
      0xbb,
      el(0xb3, uint(time)),
      el(
        0xb7,
        el(0xf7, uint(track)),
        el(0xf1, uint(cluster)),
        ...(rel === undefined ? [] : [el(0xf0, uint(rel))])
      )
    );
  const cues = el(
    0x1c53bb6b,
    cue(0, 1, cluster1At),
    cue(1000, 2, cluster1At, relative(first, 2)),
    cue(1000, 2, cluster1At, relative(first, 3)),
    cue(5000, 1, cluster2At),
    cue(5000, 2, cluster2At, relative(second, 1))
  );
  const segment = el(
    0x18538067,
    seekHead(tracksAt, cuesAt),
    info,
    tracks,
    cluster1,
    cluster2,
    cues
  );
  return join(el(0x1a45dfa3, el(0x4282, str('matroska'))), segment);
}

/** Reads at most 700 bytes at a time, as a host that cuts ranges short. */
function memory(bytes: Uint8Array): ByteReader & { reads: number } {
  const reader = {
    reads: 0,
    read: async (start: number, length: number) => {
      reader.reads++;
      return bytes.slice(start, start + Math.min(length, 700));
    },
  };
  return reader;
}

describe('openMatroska', () => {
  it('finds the subtitle tracks and their script', async () => {
    const opened = await openMatroska(memory(file()));
    assert.ok(opened);
    assert.deepEqual(
      opened.subtitles.map((track) => [track.number, track.kind]),
      [
        [2, 'ass'],
        [3, 'text'],
      ]
    );
    assert.match(opened.subtitles[0].header, /^\[Script Info\]/);
    assert.equal(opened.cues.get(2)?.length, 3);
  });
});

describe('SubtitleHarvest', () => {
  it('reads the blocks the index points at into a script', async () => {
    const opened = (await openMatroska(memory(file())))!;
    const harvest = new SubtitleHarvest(opened, opened.subtitles[0]);
    harvest.start(0);
    await harvest.settled(60_000);
    const script = assScript(opened.subtitles[0], harvest.events.values());
    const dialogue = script
      .split('\n')
      .filter((line) => line.startsWith('Dialogue:'));
    assert.deepEqual(dialogue, [
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello',
      'Dialogue: 0,0:00:01.00,0:00:03.00,Sign,,0,0,0,,{\\an8}On the door',
      'Dialogue: 0,0:00:05.00,0:00:06.50,Default,,0,0,0,,Later',
    ]);
    harvest.pause();
  });

  it('walks the clusters for a track the index skips, and unpacks it', async () => {
    const opened = (await openMatroska(memory(file())))!;
    const harvest = new SubtitleHarvest(opened, opened.subtitles[1]);
    harvest.start(0);
    await harvest.settled(60_000);
    assert.deepEqual(Array.from(harvest.events.values()), [
      { startMs: 1500, endMs: 2500, text: '<i>Plain line</i>' },
    ]);
    harvest.pause();
  });
});

describe('scriptFamilies', () => {
  it('lists the fonts the styles and overrides ask for', () => {
    const families = scriptFamilies(
      `${HEADER}\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\fn@Kozuka Gothic}Hi`
    );
    assert.deepEqual(Array.from(families).sort(), [
      'arial',
      'gandhi sans',
      'kozuka gothic',
    ]);
  });
});
