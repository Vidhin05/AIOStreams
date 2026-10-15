/**
 * A Matroska file's own subtitles, read with byte ranges and never the picture
 * or the sound: the header, the index (Cues), then one small read for each
 * subtitle block the index points at. A file whose index skips the subtitle
 * track has its clusters walked instead, which costs far more reads.
 */

export interface ByteReader {
  /** Up to `length` bytes from `start`; fewer at the end of the file, or when the source cuts a read short. */
  read(start: number, length: number): Promise<Uint8Array>;
}

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const SEEK_POSITION = 0x53ac;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const LANGUAGE = 0x22b59c;
const NAME = 0x536e;
const FLAG_DEFAULT = 0x88;
const CONTENT_ENCODINGS = 0x6d80;
const CONTENT_ENCODING = 0x6240;
const CONTENT_ENCODING_SCOPE = 0x5032;
const CONTENT_ENCODING_TYPE = 0x5033;
const CONTENT_COMPRESSION = 0x5034;
const CONTENT_COMP_ALGO = 0x4254;
const CONTENT_COMP_SETTINGS = 0x4255;
const ATTACHMENTS = 0x1941a469;
const ATTACHED_FILE = 0x61a7;
const FILE_NAME = 0x466e;
const FILE_MIME_TYPE = 0x4660;
const FILE_DATA = 0x465c;
const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;
const CUE_RELATIVE_POSITION = 0xf0;
const CUE_DURATION = 0xb2;
const CLUSTER = 0x1f43b675;
const TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const BLOCK_DURATION = 0x9b;
const SUBTITLE_TRACK = 0x11;

const HEAD_BYTES = 256 * 1024;
const MAX_ELEMENT = 16 * 1024 * 1024;
const MAX_BLOCK = 4 * 1024 * 1024;
const BLOCK_READ = 4096;
const SCAN_WINDOW = 64 * 1024;
const DEFAULT_DURATION_MS = 5000;

interface Head {
  id: number;
  /** -1 when the file leaves it unknown. */
  size: number;
  /** Bytes the id and size take. */
  length: number;
}

interface Child extends Head {
  /** Offset of the header in the bytes it was read from. */
  at: number;
  /** Offset of the data. */
  data: number;
}

function vint(
  bytes: Uint8Array,
  at: number,
  marker: boolean
): [value: number, length: number] | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (at + length > bytes.length) return null;
  const mask = 0xff >> length;
  let value = marker ? first : first & mask;
  let unknown = !marker && (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) unknown = false;
  }
  return [unknown ? -1 : value, length];
}

function head(bytes: Uint8Array, at: number): Head | null {
  const id = vint(bytes, at, true);
  if (!id || id[1] > 4) return null;
  const size = vint(bytes, at + id[1], false);
  if (!size) return null;
  return { id: id[0], size: size[0], length: id[1] + size[1] };
}

/** The elements between `from` and `to`, up to one of unknown size. */
function* children(
  bytes: Uint8Array,
  from: number,
  to: number
): Generator<Child> {
  let at = from;
  while (at < to) {
    const found = head(bytes, at);
    if (!found) return;
    yield { ...found, at, data: at + found.length };
    if (found.size < 0) return;
    at += found.length + found.size;
  }
}

const whole = (bytes: Uint8Array, child: Child) =>
  child.size >= 0 && child.data + child.size <= bytes.length;

const dataOf = (bytes: Uint8Array, child: Child) =>
  bytes.subarray(child.data, child.data + Math.max(child.size, 0));

function uint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

const utf8 = new TextDecoder('utf-8');

const text = (bytes: Uint8Array) => utf8.decode(bytes).replace(/\0+$/, '');

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part.subarray(0, length - at), at);
    at += part.length;
    if (at >= length) break;
  }
  return out;
}

/** Exactly `length` bytes from `start`, or fewer at the end of the file. */
export async function readAll(
  reader: ByteReader,
  start: number,
  length: number
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let got = 0;
  while (got < length) {
    const part = await reader.read(start + got, length - got);
    if (!part.length) break;
    parts.push(part);
    got += part.length;
  }
  return parts.length === 1 ? parts[0] : concat(parts, got);
}

/** Serves reads of the file's first bytes from what was already read. */
function withStart(reader: ByteReader, start: Uint8Array): ByteReader {
  return {
    read: (at, length) =>
      at + length <= start.length
        ? Promise.resolve(start.subarray(at, at + length))
        : reader.read(at, length),
  };
}

interface Encoding {
  /** 0 zlib, 3 header stripping; the others are not read. */
  algo: number;
  settings?: Uint8Array;
  /** 1 the blocks, 2 the codec private data. */
  scope: number;
}

export type SubtitleKind = 'ass' | 'text';

export interface MkvSubtitle {
  number: number;
  codec: string;
  /** Null for a format the page can't draw, such as PGS or VobSub pictures. */
  kind: SubtitleKind | null;
  language?: string;
  name?: string;
  isDefault: boolean;
  /** An ASS track's script header: its info, styles and event format. */
  header: string;
  encoding?: Encoding;
}

export interface Attachment {
  name: string;
  mime: string;
  /** Where the file's bytes start. */
  at: number;
  size: number;
}

interface CueEntry {
  timeMs: number;
  /** Where the cluster starts in the file. */
  cluster: number;
  /** Where the block sits in the cluster's data. */
  relative?: number;
  durationMs?: number;
}

export interface MkvFile {
  reader: ByteReader;
  /** Milliseconds in one unit of the file's timestamps. */
  scaleMs: number;
  /** In the order of the file's tracks, so the player's numbering. */
  subtitles: MkvSubtitle[];
  attachments: Attachment[];
  /** Index points for each track number. */
  cues: Map<number, CueEntry[]>;
  /** Every cluster the index points at, by time. */
  clusters: { timeMs: number; at: number }[];
  firstCluster?: number;
}

const ASS_CODECS = ['S_TEXT/ASS', 'S_TEXT/SSA', 'S_ASS', 'S_SSA'];
const TEXT_CODECS = ['S_TEXT/UTF8', 'S_TEXT/ASCII', 'S_TEXT/WEBVTT'];

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('This TV cannot unpack compressed subtitles');
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decoded(
  bytes: Uint8Array,
  encoding: Encoding | undefined,
  scope: number
): Promise<Uint8Array> {
  if (!encoding || !(encoding.scope & scope)) return bytes;
  if (encoding.algo === 3) {
    const prefix = encoding.settings ?? new Uint8Array();
    return concat([prefix, bytes], prefix.length + bytes.length);
  }
  return inflate(bytes);
}

function encodingOf(bytes: Uint8Array): Encoding | null | undefined {
  for (const entry of children(bytes, 0, bytes.length)) {
    if (entry.id !== CONTENT_ENCODING || !whole(bytes, entry)) continue;
    const data = dataOf(bytes, entry);
    let scope = 1;
    let type = 0;
    let algo = 0;
    let settings: Uint8Array | undefined;
    for (const field of children(data, 0, data.length)) {
      if (!whole(data, field)) continue;
      const value = dataOf(data, field);
      if (field.id === CONTENT_ENCODING_SCOPE) scope = uint(value);
      if (field.id === CONTENT_ENCODING_TYPE) type = uint(value);
      if (field.id !== CONTENT_COMPRESSION) continue;
      for (const part of children(value, 0, value.length)) {
        if (!whole(value, part)) continue;
        if (part.id === CONTENT_COMP_ALGO) algo = uint(dataOf(value, part));
        if (part.id === CONTENT_COMP_SETTINGS)
          settings = dataOf(value, part).slice();
      }
    }
    // Encrypted, or packed in a way the page can't undo.
    if (type !== 0 || (algo !== 0 && algo !== 3)) return null;
    return { algo, settings, scope };
  }
  return undefined;
}

async function readTracks(bytes: Uint8Array): Promise<MkvSubtitle[]> {
  const out: MkvSubtitle[] = [];
  for (const entry of children(bytes, 0, bytes.length)) {
    if (entry.id !== TRACK_ENTRY || !whole(bytes, entry)) continue;
    const data = dataOf(bytes, entry);
    let type = 0;
    let number = 0;
    let codec = '';
    let language: string | undefined;
    let name: string | undefined;
    let isDefault = true;
    let codecPrivate: Uint8Array | undefined;
    let encoding: Encoding | null | undefined;
    for (const field of children(data, 0, data.length)) {
      if (!whole(data, field)) continue;
      const value = dataOf(data, field);
      if (field.id === TRACK_TYPE) type = uint(value);
      else if (field.id === TRACK_NUMBER) number = uint(value);
      else if (field.id === CODEC_ID) codec = text(value);
      else if (field.id === LANGUAGE) language = text(value);
      else if (field.id === NAME) name = text(value);
      else if (field.id === FLAG_DEFAULT) isDefault = uint(value) === 1;
      else if (field.id === CODEC_PRIVATE) codecPrivate = value;
      else if (field.id === CONTENT_ENCODINGS) encoding = encodingOf(value);
    }
    if (type !== SUBTITLE_TRACK) continue;
    let kind: SubtitleKind | null = ASS_CODECS.includes(codec)
      ? 'ass'
      : TEXT_CODECS.includes(codec)
        ? 'text'
        : null;
    if (encoding === null) kind = null;
    let header = '';
    if (kind === 'ass' && codecPrivate) {
      try {
        header = text(await decoded(codecPrivate, encoding ?? undefined, 2));
      } catch {
        kind = null;
      }
    }
    out.push({
      number,
      codec,
      kind,
      language,
      name,
      isDefault,
      header,
      encoding: encoding ?? undefined,
    });
  }
  return out;
}

/** Adds what `bytes` points at to `into`, and another seek head to `more`. */
function readSeekHead(
  bytes: Uint8Array,
  segment: number,
  into: Map<number, number>,
  more: number[]
): void {
  for (const seek of children(bytes, 0, bytes.length)) {
    if (seek.id !== SEEK || !whole(bytes, seek)) continue;
    const data = dataOf(bytes, seek);
    let id = 0;
    let position = -1;
    for (const field of children(data, 0, data.length)) {
      if (!whole(data, field)) continue;
      if (field.id === SEEK_ID) id = uint(dataOf(data, field));
      if (field.id === SEEK_POSITION) position = uint(dataOf(data, field));
    }
    if (!id || position < 0) continue;
    if (id === SEEK_HEAD) more.push(segment + position);
    else if (!into.has(id)) into.set(id, segment + position);
  }
}

function readCues(
  bytes: Uint8Array,
  segment: number,
  scaleMs: number
): Pick<MkvFile, 'cues' | 'clusters'> {
  const cues = new Map<number, CueEntry[]>();
  const clusters = new Map<number, number>();
  for (const point of children(bytes, 0, bytes.length)) {
    if (point.id !== CUE_POINT || !whole(bytes, point)) continue;
    const data = dataOf(bytes, point);
    let time = 0;
    const positions: Uint8Array[] = [];
    for (const field of children(data, 0, data.length)) {
      if (!whole(data, field)) continue;
      if (field.id === CUE_TIME) time = uint(dataOf(data, field));
      if (field.id === CUE_TRACK_POSITIONS) positions.push(dataOf(data, field));
    }
    for (const position of positions) {
      let track = 0;
      let cluster = -1;
      let relative: number | undefined;
      let duration: number | undefined;
      for (const field of children(position, 0, position.length)) {
        if (!whole(position, field)) continue;
        const value = uint(dataOf(position, field));
        if (field.id === CUE_TRACK) track = value;
        else if (field.id === CUE_CLUSTER_POSITION) cluster = value;
        else if (field.id === CUE_RELATIVE_POSITION) relative = value;
        else if (field.id === CUE_DURATION) duration = value;
      }
      if (!track || cluster < 0) continue;
      const at = segment + cluster;
      const timeMs = time * scaleMs;
      const list = cues.get(track) ?? [];
      list.push({
        timeMs,
        cluster: at,
        relative,
        ...(duration !== undefined && { durationMs: duration * scaleMs }),
      });
      cues.set(track, list);
      const known = clusters.get(at);
      if (known === undefined || timeMs < known) clusters.set(at, timeMs);
    }
  }
  for (const list of cues.values()) list.sort((a, b) => a.timeMs - b.timeMs);
  return {
    cues,
    clusters: Array.from(clusters, ([at, timeMs]) => ({ at, timeMs })).sort(
      (a, b) => a.at - b.at
    ),
  };
}

async function readElement(
  reader: ByteReader,
  at: number,
  id: number
): Promise<Uint8Array | null> {
  const top = await readAll(reader, at, 16);
  const found = head(top, 0);
  if (!found || found.id !== id || found.size < 0 || found.size > MAX_ELEMENT)
    return null;
  return readAll(reader, at + found.length, found.size);
}

const FONT_NAME = /\.(ttf|otf|ttc|otc)$/i;

async function readAttachments(
  reader: ByteReader,
  at: number
): Promise<Attachment[]> {
  const top = await readAll(reader, at, 16);
  const found = head(top, 0);
  if (!found || found.id !== ATTACHMENTS || found.size < 0) return [];
  const end = at + found.length + found.size;
  const out: Attachment[] = [];
  let next = at + found.length;
  while (next < end && out.length < 500) {
    const chunk = await readAll(reader, next, 4096);
    const file = head(chunk, 0);
    if (!file || file.size < 0) break;
    if (file.id === ATTACHED_FILE) {
      let name = '';
      let mime = '';
      let data: { at: number; size: number } | null = null;
      const to = Math.min(chunk.length, file.length + file.size);
      for (const field of children(chunk, file.length, to)) {
        if (field.id === FILE_DATA)
          data = { at: next + field.data, size: field.size };
        if (!whole(chunk, field)) continue;
        if (field.id === FILE_NAME) name = text(dataOf(chunk, field));
        if (field.id === FILE_MIME_TYPE) mime = text(dataOf(chunk, field));
      }
      if (data && data.size > 0) out.push({ name, mime, ...data });
    }
    next += file.length + file.size;
  }
  return out;
}

export const isFont = (file: Attachment) =>
  /font|truetype|opentype|sfnt/i.test(file.mime) || FONT_NAME.test(file.name);

/**
 * The subtitle tracks, attachments and index of a Matroska file, or null for
 * a file that is not one or has no subtitle track.
 */
export async function openMatroska(
  source: ByteReader
): Promise<MkvFile | null> {
  const start = await readAll(source, 0, HEAD_BYTES);
  const reader = withStart(source, start);
  const ebml = head(start, 0);
  if (!ebml || ebml.id !== EBML || ebml.size < 0) return null;
  let segment: Child | undefined;
  for (const child of children(start, ebml.length + ebml.size, start.length)) {
    if (child.id === SEGMENT) {
      segment = child;
      break;
    }
  }
  if (!segment) return null;
  const segmentAt = segment.data;
  const found = new Map<number, number>();
  const seen: number[] = [];
  const more: number[] = [];
  let firstCluster: number | undefined;
  let after = segmentAt;
  for (const child of children(start, segmentAt, start.length)) {
    if (child.id === CLUSTER) {
      firstCluster = child.at;
      break;
    }
    after = child.size < 0 ? Infinity : child.data + child.size;
    if (child.id !== SEEK_HEAD) {
      if (!found.has(child.id)) found.set(child.id, child.at);
      continue;
    }
    seen.push(child.at);
    if (whole(start, child))
      readSeekHead(dataOf(start, child), segmentAt, found, more);
    else more.push(child.at);
  }
  // A seek head can point at a second one, often at the end of the file.
  for (const at of more.filter((at) => !seen.includes(at)).slice(0, 2)) {
    const bytes = await readElement(reader, at, SEEK_HEAD);
    if (bytes) readSeekHead(bytes, segmentAt, found, []);
  }
  const at = (id: number) => found.get(id);
  const tracksAt = at(TRACKS);
  if (tracksAt === undefined) return null;
  const tracks = await readElement(reader, tracksAt, TRACKS);
  if (!tracks) return null;
  const subtitles = await readTracks(tracks);
  if (!subtitles.length) return null;
  let scaleMs = 1;
  const infoAt = at(INFO);
  const info =
    infoAt === undefined ? null : await readElement(reader, infoAt, INFO);
  if (info) {
    for (const field of children(info, 0, info.length)) {
      if (field.id === TIMESTAMP_SCALE && whole(info, field))
        scaleMs = uint(dataOf(info, field)) / 1e6 || 1;
    }
  }
  const attachmentsAt = at(ATTACHMENTS);
  const cuesAt = at(CUES);
  const [attachments, cueBytes] = await Promise.all([
    attachmentsAt === undefined
      ? []
      : readAttachments(reader, attachmentsAt).catch(() => []),
    cuesAt === undefined ? null : readElement(reader, cuesAt, CUES),
  ]);
  const index = cueBytes
    ? readCues(cueBytes, segmentAt, scaleMs)
    : { cues: new Map<number, CueEntry[]>(), clusters: [] };
  // Without an index the clusters are walked from the first, which can lie past big attachments.
  for (
    let hops = 0;
    !cueBytes && firstCluster === undefined && hops < 32;
    hops++
  ) {
    if (!Number.isFinite(after)) break;
    const found = head(await readAll(reader, after, 16), 0);
    if (!found || found.size < 0) break;
    if (found.id === CLUSTER) firstCluster = after;
    else after += found.length + found.size;
  }
  return {
    reader,
    scaleMs,
    subtitles,
    attachments,
    ...index,
    firstCluster,
  };
}

interface Block {
  track: number;
  /** Relative to the cluster, in the file's units. */
  relative: number;
  payload: Uint8Array;
  duration?: number;
}

function readBlock(bytes: Uint8Array, element: Head): Block | null {
  const parse = (data: Uint8Array): Omit<Block, 'duration'> | null => {
    const track = vint(data, 0, false);
    if (!track || data.length < track[1] + 3) return null;
    const relative = new DataView(
      data.buffer,
      data.byteOffset + track[1],
      2
    ).getInt16(0);
    // Laced frames hold several events; subtitle muxers never write them.
    if (data[track[1] + 2] & 0x06) return null;
    return { track: track[0], relative, payload: data.subarray(track[1] + 3) };
  };
  const data = bytes.subarray(element.length, element.length + element.size);
  if (element.id === SIMPLE_BLOCK) return parse(data);
  let block: Omit<Block, 'duration'> | null = null;
  let duration: number | undefined;
  for (const field of children(data, 0, data.length)) {
    if (!whole(data, field)) continue;
    if (field.id === BLOCK) block = parse(dataOf(data, field));
    if (field.id === BLOCK_DURATION) duration = uint(dataOf(data, field));
  }
  return block && { ...block, duration };
}

/** The track number at the start of a block, from the first bytes of it. */
function blockTrack(bytes: Uint8Array, element: Head): number | null {
  if (element.id === SIMPLE_BLOCK)
    return vint(bytes, element.length, false)?.[0] ?? null;
  for (const field of children(bytes, element.length, bytes.length)) {
    if (field.id === BLOCK) return vint(bytes, field.data, false)?.[0] ?? null;
  }
  return null;
}

interface ClusterHead {
  data: number;
  /** Infinity for a cluster of unknown size. */
  end: number;
  timestamp?: number;
}

export interface HarvestedEvent {
  startMs: number;
  endMs: number;
  /** The block as stored: an ASS event's fields after its times, or a caption. */
  text: string;
}

interface Task {
  timeMs: number;
  run(): Promise<void>;
  state: 'waiting' | 'running' | 'done';
  tries: number;
  retryAt: number;
}

const AHEAD_MS = 90_000;
const BEHIND_MS = 10_000;
const PARALLEL = 3;
const GIVE_UP_AFTER = 6;
const RETRY_MS = [2000, 5000, 15_000, 30_000, 60_000];

/**
 * Reads one subtitle track's blocks, nearest the playhead first, then the rest
 * of the file one at a time.
 */
export class SubtitleHarvest {
  readonly events = new Map<number, HarvestedEvent>();
  onUpdate: () => void = () => {};
  onFail: (error: unknown) => void = () => {};
  private readonly tasks: Task[] = [];
  private readonly clusters = new Map<number, Promise<ClusterHead | null>>();
  private running = 0;
  private positionMs = 0;
  private active = false;
  private failed = false;
  private worked = false;
  private failures = 0;
  private timer = 0;
  /** Walking clusters reads much of the file, so it keeps to the playhead. */
  private scanning = false;
  private waiters: { untilMs: number; resolve: () => void }[] = [];

  constructor(
    private readonly file: MkvFile,
    readonly track: MkvSubtitle
  ) {
    const cues = file.cues.get(track.number) ?? [];
    const scanned = new Set<number>();
    for (const cue of cues) {
      if (cue.relative !== undefined) {
        this.add(cue.timeMs, async () => {
          await this.readCue(cue);
        });
      } else if (!scanned.has(cue.cluster)) {
        scanned.add(cue.cluster);
        this.scanning = true;
        this.add(cue.timeMs, async () => {
          await this.scan(cue.cluster, cue.cluster + 1);
        });
      }
    }
    if (!cues.length) this.scanAll();
    this.tasks.sort((a, b) => a.timeMs - b.timeMs);
  }

  /** Harvests around `ms`, the file's own time. A harvest that gave up tries again. */
  start(ms: number): void {
    this.active = true;
    this.positionMs = ms;
    if (this.failed) {
      this.failed = false;
      this.failures = 0;
    }
    this.pump();
  }

  setPosition(ms: number): void {
    if (Math.abs(ms - this.positionMs) < 1000) return;
    this.positionMs = ms;
    if (this.active) this.pump();
  }

  pause(): void {
    this.active = false;
    window.clearTimeout(this.timer);
  }

  /** Resolves once everything up to `untilMs` is read, or it can't be. */
  settled(untilMs: number): Promise<void> {
    if (this.covered(untilMs)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ untilMs, resolve }));
  }

  private covered(untilMs: number): boolean {
    if (this.failed) return true;
    const from = this.positionMs - BEHIND_MS;
    return this.tasks.every(
      (task) =>
        task.state === 'done' ||
        task.timeMs < from ||
        task.timeMs > untilMs ||
        task.tries > 0
    );
  }

  private add(timeMs: number, run: () => Promise<void>): void {
    this.tasks.push({ timeMs, run, state: 'waiting', tries: 0, retryAt: 0 });
  }

  /** Without an index for the track, every cluster is walked for its blocks. */
  private scanAll(): void {
    this.scanning = true;
    const { clusters, firstCluster } = this.file;
    if (clusters.length) {
      clusters.forEach((cluster, i) => {
        const until = clusters[i + 1]?.at ?? Infinity;
        this.add(cluster.timeMs, async () => {
          await this.scan(cluster.at, until);
        });
      });
      return;
    }
    // No index at all: one cluster after another, from the first.
    const walk = (at: number, timeMs: number) => {
      const task: Task = {
        timeMs,
        state: 'waiting',
        tries: 0,
        retryAt: 0,
        run: async () => {
          const next = await this.scan(at, at + 1);
          if (next === null) return;
          const cluster = await this.cluster(next);
          if (cluster) walk(next, this.toMs(cluster.timestamp ?? 0));
        },
      };
      const after = this.tasks.findIndex((other) => other.timeMs > timeMs);
      this.tasks.splice(after < 0 ? this.tasks.length : after, 0, task);
    };
    if (firstCluster !== undefined) walk(firstCluster, 0);
  }

  private toMs(units: number): number {
    return units * this.file.scaleMs;
  }

  private next(): Task | undefined {
    const now = Date.now();
    const from = this.positionMs - BEHIND_MS;
    const to = this.positionMs + AHEAD_MS;
    const ready = (task: Task) =>
      task.state === 'waiting' && task.retryAt <= now;
    const near = this.tasks.find(
      (task) => ready(task) && task.timeMs >= from && task.timeMs <= to
    );
    if (near) return near;
    if (this.running > 0 || this.scanning) return;
    return (
      this.tasks.find((task) => ready(task) && task.timeMs > to) ??
      this.tasks.find(ready)
    );
  }

  private pump(): void {
    if (!this.active || this.failed) return;
    window.clearTimeout(this.timer);
    while (this.running < PARALLEL) {
      const task = this.next();
      if (!task) break;
      task.state = 'running';
      this.running++;
      task
        .run()
        .then(
          () => {
            task.state = 'done';
            this.worked = true;
            this.failures = 0;
          },
          (error: unknown) => {
            task.state = 'waiting';
            task.tries++;
            task.retryAt =
              Date.now() + RETRY_MS[Math.min(task.tries, RETRY_MS.length) - 1];
            this.failures++;
            if (!this.worked && this.failures >= GIVE_UP_AFTER) {
              this.failed = true;
              this.onFail(error);
            }
          }
        )
        .finally(() => {
          this.running--;
          this.release();
          this.pump();
        });
    }
    const now = Date.now();
    const backingOff = this.tasks.filter(
      (task) => task.state === 'waiting' && task.retryAt > now
    );
    if (this.running === 0 && backingOff.length) {
      const soonest = Math.min(...backingOff.map((task) => task.retryAt));
      this.timer = window.setTimeout(
        () => this.pump(),
        Math.max(soonest - now, 250)
      );
    }
  }

  private release(): void {
    this.waiters = this.waiters.filter((waiter) => {
      if (!this.covered(waiter.untilMs)) return true;
      waiter.resolve();
      return false;
    });
  }

  /** The cluster at `at`, or null where the clusters end. */
  private cluster(at: number): Promise<ClusterHead | null> {
    let known = this.clusters.get(at);
    if (!known) {
      known = readAll(this.file.reader, at, 64).then((bytes) => {
        const found = head(bytes, 0);
        if (!found || found.id !== CLUSTER) return null;
        let timestamp: number | undefined;
        for (const field of children(bytes, found.length, bytes.length)) {
          if (field.id === TIMESTAMP && whole(bytes, field)) {
            timestamp = uint(dataOf(bytes, field));
            break;
          }
        }
        return {
          data: at + found.length,
          end: found.size < 0 ? Infinity : at + found.length + found.size,
          timestamp,
        };
      });
      known.catch(() => this.clusters.delete(at));
      this.clusters.set(at, known);
    }
    return known;
  }

  private async keep(
    at: number,
    block: Block,
    cluster: ClusterHead,
    cue?: CueEntry
  ): Promise<void> {
    if (block.track !== this.track.number || this.events.has(at)) return;
    const startMs =
      cluster.timestamp !== undefined
        ? this.toMs(cluster.timestamp + block.relative)
        : (cue?.timeMs ?? 0);
    const durationMs =
      block.duration !== undefined
        ? this.toMs(block.duration)
        : (cue?.durationMs ?? DEFAULT_DURATION_MS);
    const payload = await decoded(block.payload, this.track.encoding, 1);
    this.events.set(at, {
      startMs,
      endMs: startMs + durationMs,
      text: text(payload),
    });
    this.onUpdate();
  }

  private async readCue(cue: CueEntry): Promise<void> {
    const cluster = await this.cluster(cue.cluster);
    if (!cluster) throw new Error('The index points at no cluster');
    const at = cluster.data + (cue.relative ?? 0);
    const first = await readAll(this.file.reader, at, BLOCK_READ);
    const found = head(first, 0);
    if (
      !found ||
      (found.id !== BLOCK_GROUP && found.id !== SIMPLE_BLOCK) ||
      found.size < 0 ||
      found.size > MAX_BLOCK
    )
      throw new Error('The index points at no block');
    const total = found.length + found.size;
    const bytes =
      total <= first.length
        ? first
        : concat(
            [
              first,
              await readAll(
                this.file.reader,
                at + first.length,
                total - first.length
              ),
            ],
            total
          );
    if (bytes.length < total) throw new Error('The block was cut short');
    const block = readBlock(bytes, found);
    if (block) await this.keep(at, block, cluster, cue);
  }

  /**
   * Walks the clusters from `from` up to `until` for the track's blocks,
   * skipping the others' data. Returns where the walk stopped, or null at the
   * end of the file.
   */
  private async scan(from: number, until: number): Promise<number | null> {
    let at = from;
    while (at < until) {
      const cluster = await this.cluster(at);
      if (!cluster) return null;
      let next = cluster.data;
      let chunk: Uint8Array = new Uint8Array();
      let chunkAt = next;
      const ensure = async (position: number, length: number) => {
        if (position >= chunkAt && position + length <= chunkAt + chunk.length)
          return;
        chunkAt = position;
        chunk = await readAll(
          this.file.reader,
          position,
          Math.max(length, SCAN_WINDOW)
        );
      };
      while (next < cluster.end) {
        await ensure(next, 32);
        const offset = next - chunkAt;
        const found = head(chunk, offset);
        if (!found) return null;
        if (found.id === CLUSTER || found.size < 0) break;
        const end = next + found.length + found.size;
        if (found.id === SIMPLE_BLOCK || found.id === BLOCK_GROUP) {
          const track = blockTrack(
            chunk.subarray(offset, Math.min(chunk.length, offset + 64)),
            found
          );
          if (track === this.track.number && found.size <= MAX_BLOCK) {
            await ensure(next, found.length + found.size);
            const bytes = chunk.subarray(next - chunkAt, end - chunkAt);
            const block = readBlock(bytes, found);
            if (block) await this.keep(next, block, cluster);
          }
        }
        next = end;
      }
      at = next;
    }
    return at;
  }
}

function stamp(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const two = (n: number) => String(n).padStart(2, '0');
  const hours = Math.floor(cs / 360000);
  const minutes = Math.floor(cs / 6000) % 60;
  const seconds = Math.floor(cs / 100) % 60;
  return `${hours}:${two(minutes)}:${two(seconds)}.${two(cs % 100)}`;
}

const ASS_FORMAT =
  'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
const SSA_FORMAT =
  'Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

/**
 * The whole script of an ASS track: its header, then a dialogue line for each
 * event read so far. A block holds a read order, then the event's fields
 * without its times.
 */
export function assScript(
  track: MkvSubtitle,
  events: Iterable<HarvestedEvent>
): string {
  let header = track.header.replace(/\r/g, '').trimEnd();
  if (!/^\[events\]/im.test(header)) header += '\n\n[Events]';
  const section = header.slice(/^\[events\]/im.exec(header)!.index);
  let declared = /^format:(.*)$/im.exec(section)?.[1];
  if (!declared) {
    declared = /S_(TEXT\/)?SSA/.test(track.codec) ? SSA_FORMAT : ASS_FORMAT;
    header += `\nFormat: ${declared}`;
  }
  const format = declared.split(',').map((field) => field.trim());
  const stored = [
    'readorder',
    ...format
      .map((field) => field.toLowerCase())
      .filter((field) => field !== 'start' && field !== 'end'),
  ];
  const lines = Array.from(events, (event) => {
    const parts = event.text.split(',');
    const values = new Map<string, string>();
    stored.forEach((field, i) =>
      values.set(
        field,
        i === stored.length - 1 ? parts.slice(i).join(',') : (parts[i] ?? '')
      )
    );
    const row = format.map((field) => {
      const key = field.toLowerCase();
      if (key === 'start') return stamp(event.startMs);
      if (key === 'end') return stamp(event.endMs);
      return (values.get(key) ?? '').replace(/\r?\n/g, '\\N');
    });
    const order = Number(values.get('readorder')) || 0;
    return { order, start: event.startMs, row };
  })
    .sort((a, b) => a.order - b.order || a.start - b.start)
    .map((line) => `Dialogue: ${line.row.join(',')}`);
  return `${header}\n${lines.join('\n')}\n`;
}

/** The families a script asks for: its styles' fonts and every `\fn`. */
export function scriptFamilies(script: string): Set<string> {
  const families = new Set<string>();
  const add = (name: string) => {
    const family = name.trim().replace(/^@/, '').toLowerCase();
    if (family) families.add(family);
  };
  let fontAt = -1;
  for (const row of script.split('\n')) {
    const line = row.trim();
    const format = /^format:(.*)$/i.exec(line);
    if (format && fontAt < 0) {
      const fields = format[1].split(',').map((f) => f.trim().toLowerCase());
      if (fields.includes('fontname')) fontAt = fields.indexOf('fontname');
    }
    const style = /^style:(.*)$/i.exec(line);
    if (style && fontAt >= 0) add(style[1].split(',')[fontAt] ?? '');
  }
  for (const match of script.matchAll(/\\fn([^\\}]*)/g)) add(match[1]);
  return families;
}

/** The names a font file answers to: family, full and PostScript names, lower case. */
async function fontNames(
  reader: ByteReader,
  font: Attachment
): Promise<string[]> {
  const top = await readAll(reader, font.at, Math.min(font.size, 4096));
  const at = async (offset: number, length: number) =>
    offset + length <= top.length
      ? top.subarray(offset, offset + length)
      : readAll(reader, font.at + offset, Math.min(length, font.size - offset));
  const view = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (top.length < 12) return [];
  const first = view(top);
  const faces =
    first.getUint32(0) === 0x74746366
      ? Array.from({ length: Math.min(first.getUint32(8), 16) }, (_, i) =>
          first.getUint32(12 + i * 4)
        )
      : [0];
  const names = new Set<string>();
  for (const face of faces) {
    const counts = await at(face, 12);
    if (counts.length < 12) continue;
    const tables = view(counts).getUint16(4);
    const records = view(await at(face + 12, tables * 16));
    for (let i = 0; i < tables && (i + 1) * 16 <= records.byteLength; i++) {
      if (records.getUint32(i * 16) !== 0x6e616d65) continue;
      const offset = records.getUint32(i * 16 + 8);
      const length = Math.min(records.getUint32(i * 16 + 12), 256 * 1024);
      const table = await at(offset, length);
      const data = view(table);
      if (table.length < 6) break;
      const count = data.getUint16(2);
      const strings = data.getUint16(4);
      for (let r = 0; r < count && 6 + (r + 1) * 12 <= table.length; r++) {
        const row = 6 + r * 12;
        const platform = data.getUint16(row);
        const nameId = data.getUint16(row + 6);
        if (![1, 4, 6, 16].includes(nameId)) continue;
        const size = data.getUint16(row + 8);
        const from = strings + data.getUint16(row + 10);
        const bytes = table.subarray(from, from + size);
        let name = '';
        if (platform === 0 || platform === 3) {
          for (let c = 0; c + 1 < bytes.length; c += 2)
            name += String.fromCharCode((bytes[c] << 8) | bytes[c + 1]);
        } else if (platform === 1) {
          name = String.fromCharCode(...bytes);
        }
        name = name.trim().toLowerCase();
        if (name) names.add(name);
      }
      break;
    }
  }
  return Array.from(names);
}

/** The fonts a file carries, read only when a script asks for one. */
export class AttachedFonts {
  private readonly names = new Map<Attachment, Promise<string[]>>();
  private readonly taken = new Set<Attachment>();

  constructor(private readonly file: MkvFile) {}

  /** Each font `families` needs that was not handed out before. */
  async take(families: Set<string>): Promise<Uint8Array[]> {
    const fonts = this.file.attachments.filter(
      (file) => isFont(file) && !this.taken.has(file)
    );
    const wanted = await Promise.all(
      fonts.map(async (font) => {
        let names = this.names.get(font);
        if (!names) {
          names = fontNames(this.file.reader, font).catch(() => []);
          this.names.set(font, names);
        }
        return (await names).some((name) => families.has(name));
      })
    );
    const out: Uint8Array[] = [];
    for (const [i, font] of fonts.entries()) {
      if (!wanted[i] || this.taken.has(font)) continue;
      this.taken.add(font);
      const bytes = await readAll(this.file.reader, font.at, font.size).catch(
        () => null
      );
      if (bytes?.length === font.size) out.push(bytes);
      else this.taken.delete(font);
    }
    return out;
  }
}
