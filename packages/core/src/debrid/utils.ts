import { ParsedFile } from '../db/schemas';
import { createLogger } from '../utils';

const logger = createLogger('debrid');

interface FileWithParsedInfo {
  name: string;
  size: number;
  index: number;
  parsed: ParsedFile;
  isVideo: boolean;
  path?: string;
  link?: string;
}

export function findMatchingFileInTorrent(
  files: FileWithParsedInfo[],
  chosenIndex?: number,
  requestedFilename?: string,
  requestedTitles?: string[],
  season?: string,
  episode?: string,
  absoluteEpisode?: string,
  expectLinks?: boolean
): FileWithParsedInfo | null {
  let chosenFile = null;

  for (const file of files) {
    if (!file.isVideo || file.name?.includes('sample')) {
      continue;
    }

    if (season || episode || absoluteEpisode) {
      if (
        (requestedTitles && file.parsed.title
          ? requestedTitles.some(
              (title) =>
                file.parsed.title!.toLowerCase() === title.toLowerCase()
            )
          : true) &&
        ((absoluteEpisode &&
          !file.parsed.season &&
          file.parsed.episode === Number(absoluteEpisode)) ||
          (season && !episode && file.parsed.season === Number(season)) ||
          (episode && !season && file.parsed.episode === Number(episode)) ||
          (season &&
            episode &&
            file.parsed.season === Number(season) &&
            file.parsed.episode === Number(episode)))
      ) {
        chosenFile = file;
        break;
      }
    } else {
      if (requestedTitles) {
        if (
          requestedTitles.some(
            (title) => file.parsed.title?.toLowerCase() === title.toLowerCase()
          )
        ) {
          chosenFile = file;
          break;
        }
      }
    }
  }

  if (chosenFile) {
    return chosenFile;
  }

  if (requestedFilename) {
    const requestedFile = files.find(
      (file) => file.name.toLowerCase() === requestedFilename.toLowerCase()
    );
    if (requestedFile) {
      return requestedFile;
    }
  }

  if (chosenIndex) {
    const fileIdx = files.find((file) => file.index === chosenIndex);
    if (fileIdx) return fileIdx;
  }

  if (files.length > 0 && (!expectLinks || files.some((file) => file.link))) {
    return files
      .filter((file) => !expectLinks || file.link)
      .reduce((largest, current) =>
        current.size > largest.size ? current : largest
      );
  }

  return null;
}

export function isVideoFile(filename: string): boolean {
  const videoExtensions = [
    '.3g2',
    '.3gp',
    '.amv',
    '.asf',
    '.avi',
    '.drc',
    '.f4a',
    '.f4b',
    '.f4p',
    '.f4v',
    '.flv',
    '.gif',
    '.gifv',
    '.m2v',
    '.m4p',
    '.m4v',
    '.mkv',
    '.mov',
    '.mp2',
    '.mp4',
    '.mpg',
    '.mpeg',
    '.mpv',
    '.mng',
    '.mpe',
    '.mxf',
    '.nsv',
    '.ogg',
    '.ogv',
    '.qt',
    '.rm',
    '.rmvb',
    '.roq',
    '.svi',
    '.webm',
    '.wmv',
    '.yuv',
    '.m3u8',
    '.m2ts',
  ];
  return videoExtensions.some((ext) => filename.endsWith(ext));
}
