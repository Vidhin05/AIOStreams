import type React from 'react';
import {
  webosTextPipeline,
  type WebosTextInfo,
  type WebosTextPipeline,
} from '../hosts/webos-media';
import { checkSubtitleFile, readSubtitleCues } from '../subtitles/files';
import { subtitleLine } from '../subtitles/style';
import type { SourceInfo } from '../types';
import { ofType, ownTrackLabel, trackLabel } from './controller';
import type {
  EngineFactory,
  EngineFile,
  EngineState,
  EngineTrack,
} from './engine';
import { isFullscreen, toggleDocumentFullscreen } from './fullscreen';

const SUBTITLE_TYPES = ['srt', 'vtt', 'ass', 'ssa'];

interface AudioTrack {
  enabled: boolean;
  label: string;
  language: string;
}

interface AudioTrackList extends EventTarget {
  readonly length: number;
  [index: number]: AudioTrack;
}

const audioTracksOf = (video: HTMLVideoElement) =>
  (video as { audioTracks?: AudioTrackList }).audioTracks;

const listed = (list: AudioTrackList) =>
  Array.from({ length: list.length }, (_, i) => list[i]);

const EMBEDDED = 'embedded:';

/** The file's own subtitles, in the order the TV's pipeline numbers them. */
function embeddedSubtitles(source: SourceInfo): EngineTrack[] {
  return ofType(source, 'Subtitle')
    .filter((s) => s.DeliveryMethod !== 'External')
    .map((s, i) => ({
      id: `${EMBEDDED}${i}`,
      type: 'subtitle' as const,
      label: trackLabel(s, i + 1),
      lang: s.Language ?? undefined,
      title: s.Title ?? undefined,
      forced: s.IsForced,
      hearingImpaired: s.IsHearingImpaired,
    }));
}

function pipelineSubtitles(tracks: WebosTextInfo[]): EngineTrack[] {
  return tracks.map((track, i) => ({
    id: `${EMBEDDED}${i}`,
    type: 'subtitle' as const,
    label: ownTrackLabel(track.title || track.codec, track.language, i + 1),
    lang: track.language,
    title: track.title,
  }));
}

interface FileTrack {
  id: string;
  label: string;
  track: TextTrack;
}

/**
 * The page's own `<video>`. The server's subtitles are `<track>`s, and files
 * the user adds are text tracks after them. webOS never fills `textTracks`
 * from the file, so those come from the TV's media pipeline.
 */
export function videoEngine(
  video: React.RefObject<HTMLVideoElement | null>
): EngineFactory {
  return (emit) => {
    let file: EngineFile | null = null;
    let elements: HTMLTrackElement[] = [];
    let files: FileTrack[] = [];
    let embedded: EngineTrack[] = [];
    let pipeline: WebosTextPipeline | null = null;
    let delayMs = 0;
    let line = subtitleLine();
    let detach = () => {};
    // A text track's cues load late, so each one remembers the shift it has.
    const shifted = new WeakMap<TextTrack, number>();
    // Browsers disagree on where a cue the file leaves unplaced goes.
    const placed = new WeakSet<VTTCue>();

    const textTracks = () => [
      ...elements.map((e) => e.track),
      ...files.map((f) => f.track),
    ];
    // LG's player keeps one subtitle event and drops the others spoken with it.
    // The page draws every line that is on at this moment, and the track stays
    // hidden so the TV does not paint its single line on top.
    let drawn = '';
    const pageText = () => {
      const at = video.current?.currentTime ?? 0;
      return textTracks()
        .filter((track) => track.mode !== 'disabled')
        .flatMap((track) => Array.from(track.cues ?? []))
        .filter((cue) => cue.startTime <= at && at < cue.endTime)
        .map((cue) => cue.text.trim())
        .filter(Boolean)
        .join('\n');
    };
    const paintText = () => {
      if (!pipeline) return;
      const text = pageText();
      if (text === drawn) return;
      drawn = text;
      emit({ type: 'subtitle-text', text });
    };
    const showTrack = (on: boolean): TextTrackMode =>
      on ? (pipeline ? 'hidden' : 'showing') : 'disabled';
    const shiftCues = () => {
      for (const track of textTracks()) {
        const cues = track.cues;
        if (!cues?.length) continue;
        const by = (delayMs - (shifted.get(track) ?? 0)) / 1000;
        if (!by) continue;
        for (const cue of Array.from(cues)) {
          cue.startTime += by;
          cue.endTime += by;
        }
        shifted.set(track, delayMs);
      }
    };
    const placeCues = () => {
      for (const track of textTracks()) {
        for (const cue of Array.from(track.cues ?? [])) {
          const vtt = cue as VTTCue;
          if (vtt.line !== 'auto' && !placed.has(vtt)) continue;
          placed.add(vtt);
          vtt.snapToLines = false;
          vtt.line = line;
          vtt.lineAlign = 'end';
        }
      }
    };
    const listTracks = () => {
      const audio = video.current && audioTracksOf(video.current);
      const audioTracks = audio ? listed(audio) : [];
      const tracks: EngineTrack[] = [
        ...audioTracks.map((t, i) => ({
          id: String(i),
          type: 'audio' as const,
          label: ownTrackLabel(t.label, t.language, i + 1),
          lang: t.language,
          title: t.label,
        })),
        ...embedded,
        ...files.map(({ id, label }) => ({
          id,
          type: 'subtitle' as const,
          label,
          external: true,
        })),
      ];
      emit({ type: 'tracks', tracks });
      const on = audioTracks.findIndex((t) => t.enabled);
      set({ audio: on < 0 ? null : String(on) });
    };
    const setSubtitle = (id: string | null) => {
      const own = id?.startsWith(EMBEDDED)
        ? Number(id.slice(EMBEDDED.length))
        : null;
      pipeline?.show(own);
      elements.forEach((e, i) => {
        e.track.mode = showTrack(
          own === null && file?.subtitles[i]?.id === id
        );
      });
      for (const f of files) f.track.mode = showTrack(f.id === id);
      shiftCues();
      paintText();
      set({ subtitle: id });
    };
    const set = (state: EngineState) => emit({ type: 'state', state });
    const removeElements = () => {
      for (const e of elements) e.remove();
      elements = [];
    };

    return {
      load(next) {
        const el = video.current;
        if (!el) return;
        detach();
        removeElements();
        file = next;
        delayMs = next.subtitleDelayMs;
        drawn = '';
        embedded = [];
        pipeline = webosTextPipeline(el);
        if (pipeline) {
          embedded = embeddedSubtitles(next.source);
          pipeline.watch((tracks) => {
            // The same count keeps the names already on these tracks. An empty
            // report must not wipe tracks the file already listed.
            if (!tracks.length || tracks.length === embedded.length) return;
            embedded = pipelineSubtitles(tracks);
            listTracks();
            emit({ type: 'loaded' });
          });
        }
        elements = next.subtitles.map((s) => {
          const track = document.createElement('track');
          track.kind = 'subtitles';
          track.src = s.url;
          track.label = s.label;
          if (s.lang) track.srclang = s.lang;
          track.track.addEventListener('cuechange', paintText);
          el.append(track);
          return track;
        });
        if (next.volume) {
          el.volume = Math.min(1, next.volume.volume);
          el.muted = next.volume.muted;
        }
        const bufferedEnd = () => {
          for (let i = el.buffered.length - 1; i >= 0; i--) {
            if (el.buffered.start(i) <= el.currentTime)
              return el.buffered.end(i) * 1000;
          }
          return 0;
        };
        const handlers: Record<string, () => void> = {
          loadedmetadata: () => {
            if (next.startMs) el.currentTime = next.startMs / 1000;
            set({ durationMs: el.duration * 1000 || 0 });
            listTracks();
            emit({ type: 'loaded' });
          },
          durationchange: () => set({ durationMs: el.duration * 1000 || 0 }),
          playing: () => set({ started: true, paused: false, waiting: false }),
          pause: () => set({ paused: true }),
          play: () => set({ paused: false }),
          waiting: () => set({ waiting: true }),
          canplay: () => set({ waiting: false }),
          timeupdate: () => {
            paintText();
            emit({
              type: 'position',
              positionMs: el.currentTime * 1000,
              bufferedMs: bufferedEnd(),
            });
          },
          progress: () => emit({ type: 'position', bufferedMs: bufferedEnd() }),
          volumechange: () => set({ volume: el.volume, muted: el.muted }),
          ratechange: () => set({ rate: el.playbackRate }),
          ended: () => emit({ type: 'ended' }),
          seeked: () => {
            pipeline?.reapply();
            paintText();
          },
          error: () =>
            emit({
              type: 'failed',
              error:
                'this browser cannot play this version. Nothing is converted on the server, so try another version, an external player or the desktop app.',
            }),
        };
        for (const [event, handler] of Object.entries(handlers))
          el.addEventListener(event, handler);
        const audio = audioTracksOf(el);
        const audioEvents = ['addtrack', 'removetrack', 'change'];
        for (const event of audioEvents)
          audio?.addEventListener(event, listTracks);
        const onTrackLoad = () => {
          placeCues();
          shiftCues();
          paintText();
        };
        for (const e of elements) e.addEventListener('load', onTrackLoad);
        const onFullscreen = () => set({ fullscreen: isFullscreen() });
        document.addEventListener('fullscreenchange', onFullscreen);
        detach = () => {
          for (const [event, handler] of Object.entries(handlers))
            el.removeEventListener(event, handler);
          for (const event of audioEvents)
            audio?.removeEventListener(event, listTracks);
          for (const e of elements) e.removeEventListener('load', onTrackLoad);
          document.removeEventListener('fullscreenchange', onFullscreen);
          pipeline?.close();
          pipeline = null;
          if (drawn) {
            drawn = '';
            emit({ type: 'subtitle-text', text: '' });
          }
        };
        onFullscreen();
        el.src = next.url;
      },
      // Browsers keep a closed player in their media controls until its video drops the stream.
      close() {
        detach();
        detach = () => {};
        removeElements();
        const el = video.current;
        if (!el) return;
        el.pause();
        el.removeAttribute('src');
        el.load();
      },
      setPaused(paused) {
        const el = video.current;
        if (!el) return;
        if (paused) el.pause();
        else void el.play().catch(() => {});
      },
      seek(ms) {
        if (video.current) video.current.currentTime = ms / 1000;
      },
      setVolume(volume, muted) {
        const el = video.current;
        if (!el) return;
        el.volume = Math.min(1, volume);
        el.muted = muted;
      },
      setRate(rate) {
        if (video.current) video.current.playbackRate = rate;
      },
      setAudio(id) {
        const audio = video.current && audioTracksOf(video.current);
        if (!audio) return;
        listed(audio).forEach((t, i) => (t.enabled = String(i) === id));
        set({ audio: id });
      },
      setSubtitle,
      setSubtitleDelay(ms) {
        delayMs = ms;
        shiftCues();
      },
      setStyle({ subtitleStyle, lift }) {
        line = subtitleLine(subtitleStyle, lift);
        placeCues();
      },
      toggleFullscreen: toggleDocumentFullscreen,
      // Cues carry the shift already applied, so it comes off again.
      ownLines: async (id) => {
        const cues = files.find((f) => f.id === id)?.track.cues;
        if (!cues?.length) return null;
        return Array.from(cues).map((cue) => ({
          startMs: cue.startTime * 1000 - delayMs,
          text: (cue as VTTCue).text.replace(/<[^>]*>/g, ''),
        }));
      },
      subtitleFiles: {
        types: SUBTITLE_TYPES,
        add: async (added) => {
          checkSubtitleFile(added, SUBTITLE_TYPES);
          const cues = await readSubtitleCues(added);
          const el = video.current;
          if (!el) return;
          const track = el.addTextTrack('subtitles', added.name);
          track.mode = 'hidden';
          track.addEventListener('cuechange', paintText);
          for (const cue of cues)
            track.addCue(
              new VTTCue(cue.startMs / 1000, cue.endMs / 1000, cue.text)
            );
          const id = `file:${files.length}`;
          files = [...files, { id, label: added.name, track }];
          listTracks();
          placeCues();
          setSubtitle(id);
        },
      },
      fits: true,
    };
  };
}
