import {
  Cache,
  constants,
  createLogger,
  Env,
  getSimpleTextHash,
  getTimeTakenSincePoint,
} from '../../utils';
import { DebridInterface } from '../../debrid/interface';
import { FileParser } from '../../parser';
import { ParsedId } from '../utils/id-parser';
import { Torrent } from './torrent';
import { ServiceId } from '../../utils';
import { z } from 'zod';
import { TorBoxSearchAddonUserDataSchema } from './schemas';
import { findMatchingFileInTorrent, isVideoFile } from '../../debrid/utils';
import { StremThruError } from 'stremthru';
import { TitleMetadata } from './source-handlers';
import { calculateAbsoluteEpisode } from '../utils/general';

const logger = createLogger('torbox-search');

export interface DebridFile {
  hash: string;
  filename: string;
  size: number;
  index?: number;
  service: {
    id: ServiceId;
    cached: boolean;
  };
}

export class DebridService {
  private readonly debridCache = Cache.getInstance<string, DebridFile[]>(
    'torbox-search-debrid'
  );

  private readonly debridInterface: DebridInterface;
  private readonly serviceConfig: z.infer<
    typeof TorBoxSearchAddonUserDataSchema
  >['services'][0];

  constructor(
    serviceConfig: z.infer<
      typeof TorBoxSearchAddonUserDataSchema
    >['services'][0],
    private readonly clientIp?: string
  ) {
    this.serviceConfig = serviceConfig;
    this.debridInterface = new DebridInterface(
      {
        storeName: serviceConfig.id,
        storeCredential: serviceConfig.credential,
      },
      this.clientIp
    );
  }

  public async getAvailableFiles(
    torrents: Torrent[],
    parsedId: ParsedId,
    titleMetadata?: TitleMetadata
  ): Promise<DebridFile[] | { error: { title: string; description: string } }> {
    const { id, season, episode } = parsedId;
    const absoluteEpisode =
      season && episode && titleMetadata?.seasons
        ? calculateAbsoluteEpisode(season, episode, titleMetadata.seasons)
        : undefined;

    const cachedResults: DebridFile[] = [];
    const torrentsToCheck: Torrent[] = [];

    for (const torrent of torrents) {
      const cacheKey = getSimpleTextHash(
        `${this.serviceConfig.id}:${torrent.hash}`
      );
      const cached = this.debridCache.get(cacheKey);

      if (cached && cached.length > 0) {
        cachedResults.push(...cached);
      } else {
        torrentsToCheck.push(torrent);
      }
    }

    let newResults: DebridFile[] = [];

    const start = Date.now();
    if (torrentsToCheck.length > 0) {
      try {
        const instantAvailability = await this.debridInterface.checkMagnets(
          torrentsToCheck.map((t) => t.hash),
          id
        );

        for (const torrent of torrentsToCheck) {
          const item = instantAvailability.data.items.find(
            (avail) => avail.hash === torrent.hash
          );

          if (!item) {
            logger.debug(
              `[${this.serviceConfig.id}] Hash ${torrent.hash} not found in instant availability response`
            );
            continue;
          }

          const file =
            item.files && item.files.length > 0
              ? findMatchingFileInTorrent(
                  item.files.map((file) => ({
                    ...file,
                    parsed: FileParser.parse(file.name),
                    isVideo: isVideoFile(file.name),
                  })),
                  torrent.fileIdx,
                  undefined,
                  titleMetadata?.titles,
                  season,
                  episode,
                  absoluteEpisode,
                  false
                )
              : { name: torrent.title, size: torrent.size, index: -1 }; // Fallback for torrents with no file list

          if (file) {
            const result: DebridFile = {
              hash: torrent.hash,
              filename: file.name,
              size: file.size,
              index: file.index !== -1 ? file.index : undefined,
              service: {
                id: this.serviceConfig.id,
                cached: item.status === 'cached',
              },
            };
            newResults.push(result);

            const cacheKey = getSimpleTextHash(
              `${this.serviceConfig.id}:${torrent.hash}`
            );

            this.debridCache.set(
              cacheKey,
              [result],
              Env.BUILTIN_TORBOX_SEARCH_INSTANT_AVAILABILITY_CACHE_TTL
            );
          }
        }
        // logger.info(
        //   `[${this.serviceConfig.id}] Checked ${torrentsToCheck.length} uncached magnets  in ${getTimeTakenSincePoint(start)}`
        // );
      } catch (error) {
        if (error instanceof StremThruError) {
          logger.error(
            `Got StremThru error during debrid check: ${error.code}: ${error.message}`
          );
          const serviceName =
            constants.SERVICE_DETAILS[this.serviceConfig.id].shortName;
          switch (error.code) {
            case 'FORBIDDEN':
            case 'UNAUTHORIZED':
              return {
                error: {
                  title: serviceName,
                  description: 'Invalid/expired credentials',
                },
              };
            default:
              return {
                error: {
                  title: serviceName,
                  description: 'Internal Server Error',
                },
              };
          }
        }
        logger.error(`Unexpected error during debrid check:`, error);
        return [];
      }
    }

    // count number of cached results
    const cachedCount = [...cachedResults, ...newResults].filter(
      (result) => result.service.cached
    ).length;

    logger.debug(
      `[${this.serviceConfig.id}] Checked ${torrents.length} magnets in ${getTimeTakenSincePoint(start)}. ${cachedCount} / ${torrents.length} cached`
    );

    return [...cachedResults, ...newResults];
  }
}
