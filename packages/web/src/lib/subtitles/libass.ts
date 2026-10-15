/**
 * libass, compiled to WebAssembly, drawing ASS on a canvas over the video as
 * the script asks: its fonts, colours, borders, positions and motion. The LG
 * package carries its files (`packages/smart-tv/scripts/build.mjs`); no
 * other build does.
 */

const asset = (name: string) =>
  new URL(`static/jassub/${name}`, document.baseURI).href;

const EMPTY = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const READY_MS = 20_000;

export interface AssRenderer {
  show(script: string): void;
  clear(): void;
  addFont(font: Uint8Array): void;
  setDelay(ms: number): void;
  destroy(): void;
}

interface Box {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** Where the picture sits in the element, for the way the video is fitted. */
function pictureBox(video: HTMLVideoElement): Box {
  const { offsetWidth: width, offsetHeight: height } = video;
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return { width, height, x: 0, y: 0 };
  const fit = getComputedStyle(video).objectFit;
  if (fit === 'fill') return { width, height, x: 0, y: 0 };
  const scale = (fit === 'cover' ? Math.max : Math.min)(
    width / videoWidth,
    height / videoHeight
  );
  const w = Math.round(videoWidth * scale);
  const h = Math.round(videoHeight * scale);
  return { width: w, height: h, x: (width - w) / 2, y: (height - h) / 2 };
}

/** Starts libass over `video`; rejects when this TV can't run it. */
export async function assRenderer(
  video: HTMLVideoElement,
  delayMs: number
): Promise<AssRenderer> {
  const { default: Jassub } = await import('jassub-webos5');
  const renderer = new Jassub({
    video,
    subContent: EMPTY,
    workerUrl: asset('jassub-worker.js'),
    wasmUrl: asset('jassub-worker.wasm'),
    availableFonts: { 'liberation sans': asset('default.woff2') },
    fallbackFont: 'liberation sans',
    // The TV draws the picture on its own plane, so the page may never see a frame.
    onDemandRender: false,
    targetFps: 30,
    timeOffset: -delayMs / 1000,
    libassMemoryLimit: 64,
    libassGlyphLimit: 32,
  });
  const internals = renderer as unknown as {
    _getVideoPosition: () => Box;
    timeOffset: number;
  };
  // libass would size the canvas from a picture the TV reports late, or as 0×0.
  internals._getVideoPosition = () => pictureBox(video);
  renderer.resize();
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('libass did not start')),
      READY_MS
    );
    renderer.addEventListener(
      'ready',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    renderer.addEventListener(
      'error',
      (event) => {
        window.clearTimeout(timer);
        reject(
          new Error(String((event as ErrorEvent).message || 'libass failed'))
        );
      },
      { once: true }
    );
  }).catch((error: unknown) => {
    renderer.destroy();
    throw error;
  });
  return {
    show: (script) => renderer.setTrack(script),
    clear: () => renderer.setTrack(EMPTY),
    addFont: (font) => renderer.addFont(font),
    setDelay(ms) {
      internals.timeOffset = -ms / 1000;
      renderer.setCurrentTime(video.paused, video.currentTime - ms / 1000);
    },
    destroy: () => renderer.destroy(),
  };
}
