/** True in the standalone build, which picks its server instead of being served by one. */
declare const __STANDALONE__: boolean;

/** The commit this build comes from, with its date. */
declare const __APP_COMMIT__: string;

/** What the page uses of libass; the package's own typings sit outside its `exports`. */
declare module 'jassub-webos5' {
  export default class JASSUB extends EventTarget {
    constructor(options: {
      video: HTMLVideoElement;
      subContent: string;
      workerUrl: string;
      wasmUrl: string;
      availableFonts: Record<string, string>;
      fallbackFont: string;
      onDemandRender: boolean;
      targetFps: number;
      timeOffset: number;
      libassMemoryLimit: number;
      libassGlyphLimit: number;
    });
    resize(): void;
    setTrack(content: string): void;
    addFont(font: Uint8Array): void;
    setCurrentTime(isPaused?: boolean, currentTime?: number): void;
    destroy(error?: string): void;
  }
}
