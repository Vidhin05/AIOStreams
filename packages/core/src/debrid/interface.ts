import { StremThru, StremThruError } from 'stremthru';
import { constants, Env, ServiceId, createLogger, Cache } from '../utils';
import { TorboxApi } from '@torbox/torbox-api';
import { z } from 'zod';
import { FileParser } from '../parser';
import { findMatchingFileInTorrent, isVideoFile } from './utils';
import { title } from 'process';

const logger = createLogger('debrid');

export type DebridErrorCode = 'NO_MATCHING_FILE';
export class DebridError extends Error {
  constructor(
    message: string,
    public readonly code: DebridErrorCode
  ) {
    super(message);
  }
}

export const getProvider = (
  storeName: ServiceId,
  storeCredential: string,
  clientIp?: string
): StremThru => {
  return new StremThru({
    baseUrl: Env.BUILTIN_STREMTHRU_URL,
    userAgent: Env.DEFAULT_USER_AGENT,
    auth: {
      store: storeName,
      token: storeCredential,
    },
    clientIp,
    timeout: 20000,
  });
};

type StoreAuth = {
  storeName: ServiceId;
  storeCredential: string;
};

export const StoreAuthSchema = z.object({
  storeName: z.enum(constants.SERVICES),
  storeCredential: z.string(),
});

const TorrentPlaybackInfoSchema = z.object({
  parsedId: z.object({
    id: z.string(),
    type: z.string(),
    season: z.string().optional(),
    episode: z.string().optional(),
    absoluteEpisode: z.string().optional(),
  }),
  type: z.literal('torrent'),
  hash: z.string(),
  title: z.string().optional(),
  magnet: z.string().optional(),
  index: z.number().optional(),
});

const UsenetPlaybackInfoSchema = z.object({
  type: z.literal('usenet'),
  title: z.string().optional(),
  nzb: z.string(),
});

export const PlaybackInfoSchema = z.discriminatedUnion('type', [
  TorrentPlaybackInfoSchema,
  UsenetPlaybackInfoSchema,
]);

type PlaybackInfo = z.infer<typeof PlaybackInfoSchema>;

export class DebridInterface {
  private readonly stremthru: StremThru;
  private readonly torboxApi: TorboxApi | undefined;
  private static playbackLinkCache = Cache.getInstance<string, string>(
    'debrid-link'
  );

  constructor(
    private readonly storeAuth: StoreAuth,
    private readonly clientIp?: string
  ) {
    const { storeName, storeCredential } = storeAuth;
    this.stremthru = getProvider(storeName, storeCredential, clientIp);
    if (storeName === 'torbox') {
      this.torboxApi = new TorboxApi({
        token: storeCredential,
      });
    }
  }

  public async checkMagnets(magnets: string[], sid?: string) {
    return await this.stremthru.store.checkMagnet({
      magnet: magnets,
      sid,
    });
  }

  public async resolve(
    playbackInfo: PlaybackInfo,
    filename: string
  ): Promise<string | undefined> {
    if (playbackInfo.type === 'torrent') {
      logger.debug(`Resolving torrent ${playbackInfo.hash}`);
      return await this.resolveTorrent(playbackInfo, filename);
    } else {
      logger.debug(`Resolving usenet ${playbackInfo.nzb}`);
      return await this.resolveUsenet(playbackInfo, filename);
    }
  }

  private async resolveTorrent(
    playbackInfo: PlaybackInfo & { type: 'torrent' },
    filename: string
  ) {
    let { hash, index, parsedId } = playbackInfo;
    const cacheKey = `${this.storeAuth.storeName}:${hash}:${index ?? 'undefined'}:${this.storeAuth.storeCredential}:${this.clientIp}`;
    const cachedLink = DebridInterface.playbackLinkCache.get(cacheKey);
    if (cachedLink) {
      logger.debug(`Using cached link for ${hash}`);
      return cachedLink;
    }
    if (index === -1) {
      index = undefined;
    }

    logger.debug(
      `Adding magnet to ${this.storeAuth.storeName} for ${playbackInfo.magnet || `magnet:?xt=urn:btih:${hash}`}`
    );
    const magnet = await this.stremthru.store.addMagnet({
      magnet: playbackInfo.magnet || `magnet:?xt=urn:btih:${hash}`,
    });

    if (magnet.data.status !== 'downloaded') {
      return undefined;
    }

    // parse files first
    const files = magnet.data.files.map((file) => {
      return {
        parsed: FileParser.parse(file.name),
        isVideo: isVideoFile(file.name),
        index: file.index,
        name: file.name,
        size: file.size,
        link: file.link,
        path: file.path,
      };
    });

    const file = findMatchingFileInTorrent(
      files,
      index,
      filename,
      undefined,
      parsedId.season,
      parsedId.episode,
      parsedId.absoluteEpisode,
      true
    );

    if (!file || !file.link) {
      throw new DebridError('No matching file found', 'NO_MATCHING_FILE');
    }

    logger.debug(`Found matching file`, {
      season: parsedId.season,
      episode: parsedId.episode,
      absoluteEpisode: parsedId.absoluteEpisode,
      chosenFile: file.name,
      availableFiles: `[${files.map((file) => file.name).join(', ')}]`,
    });

    const link = await this.stremthru.store.generateLink({
      link: file.link,
      clientIp: this.clientIp,
    });

    const playbackLink = link.data.link;
    DebridInterface.playbackLinkCache.set(cacheKey, playbackLink, 60 * 30);
    return playbackLink;
  }

  private async resolveUsenet(
    playbackInfo: PlaybackInfo & { type: 'usenet' },
    filename: string
  ): Promise<string | undefined> {
    const { nzb } = playbackInfo;

    if (!this.torboxApi) {
      throw new Error('Torbox API not available');
    }

    const nzbFile = await this.torboxApi.usenet.createUsenetDownload('v1', {
      link: nzb,
      name: filename,
    });

    logger.debug(`Created usenet download for ${nzb}: ${nzbFile.data?.detail}`);
    if (
      nzbFile.data?.detail &&
      !nzbFile.data.detail.includes('Using cached download.')
    ) {
      logger.debug(
        `Usenet download failed detected to not be cached, returning undefined`
      );
      return undefined;
    }

    if (nzbFile.data?.error || !nzbFile.data?.data?.usenetdownloadId) {
      throw new Error(
        `Usenet download failed: ${nzbFile.data?.error} ${nzbFile.data?.detail}`
      );
    }

    const link = await this.torboxApi.usenet.requestDownloadLink('v1', {
      usenetId: nzbFile.data?.data?.usenetdownloadId?.toString(),
      userIp: this.clientIp,
      redirect: 'false',
      token: this.storeAuth.storeCredential,
    });

    logger.debug(
      `Requested usenet download link for ${nzb}: ${link.data?.data} ${link.metadata.status}`
    );

    return link.data?.data ?? undefined;
  }
}
