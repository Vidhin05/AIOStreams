import { z } from 'zod';
import { Manifest, Stream } from '../../db';
import {
  createLogger,
  formatZodError,
  getTimeTakenSincePoint,
} from '../../utils';
import { TorBoxSearchAddonUserDataSchema } from './schemas';
import { TorboxApi } from '@torbox/torbox-api';
import TorboxSearchApi from './search-api';
import { IdParser } from '../utils/id-parser';
import { TorrentSourceHandler, UsenetSourceHandler } from './source-handlers';
import { TorBoxSearchAddonError } from './errors';
import { supportedIdTypes } from './search-api';
import { KitsuMetadata } from '../../metadata/kitsu';

const logger = createLogger('torbox-search');

export class TorBoxSearchAddon {
  private readonly userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>;
  private readonly searchApi: TorboxSearchApi;
  private readonly torboxApi: TorboxApi;
  private static readonly idParser: IdParser = new IdParser(supportedIdTypes);
  private readonly sourceHandlers: (
    | TorrentSourceHandler
    | UsenetSourceHandler
  )[];
  private readonly manifest: Manifest;

  constructor(
    userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>,
    private readonly clientIp?: string
  ) {
    this.userData = this.validateUserData(userData);
    this.manifest = TorBoxSearchAddon.getManifest();

    this.searchApi = new TorboxSearchApi(this.userData.torBoxApiKey);
    this.torboxApi = new TorboxApi({ token: this.userData.torBoxApiKey });

    this.sourceHandlers = this.initializeSourceHandlers();
  }

  private validateUserData(
    userData: unknown
  ): z.infer<typeof TorBoxSearchAddonUserDataSchema> {
    const { success, data, error } =
      TorBoxSearchAddonUserDataSchema.safeParse(userData);
    if (!success) {
      throw new TorBoxSearchAddonError(
        `Invalid user data: ${formatZodError(error)}`,
        400
      );
    }
    if (
      data.sources.includes('usenet') &&
      !data.services.some((service) => service.id === 'torbox')
    ) {
      data.sources = data.sources.filter((source) => source !== 'usenet');
    }
    return data;
  }

  static getManifest(): Manifest {
    return {
      id: 'com.torbox-search.viren070',
      name: 'TorBox Search',
      description: 'Search for torrents and usenet on TorBox',
      version: '1.0.0',
      types: ['movie', 'series', 'anime'],
      resources: [
        {
          name: 'stream',
          types: ['movie', 'series', 'anime'],
          idPrefixes: TorBoxSearchAddon.idParser.supportedPrefixes,
        },
      ],
      catalogs: [],
    };
  }

  private initializeSourceHandlers(): (
    | TorrentSourceHandler
    | UsenetSourceHandler
  )[] {
    const handlers = [];
    if (this.userData.sources.includes('torrent')) {
      handlers.push(
        new TorrentSourceHandler(
          this.searchApi,
          this.userData.services,
          this.userData.searchUserEngines,
          this.clientIp
        )
      );
    }
    if (this.userData.sources.includes('usenet')) {
      handlers.push(
        new UsenetSourceHandler(this.searchApi, this.userData.searchUserEngines)
      );
    }
    return handlers;
  }

  public getManifest(): Manifest {
    return this.manifest;
  }

  public async getStreams(type: string, id: string): Promise<Stream[]> {
    const parsedId = TorBoxSearchAddon.idParser.parse(id);
    if (!parsedId) {
      throw new TorBoxSearchAddonError(`Unsupported ID: ${id}`, 400);
    }

    const metadataStart = Date.now();
    if (
      ['mal_id', 'kitsu_id', 'anilist_id', 'anidb_id'].includes(parsedId.type)
    ) {
      const kitsuMetadata = new KitsuMetadata();
      const metadata = await kitsuMetadata.getMetadata(parsedId, type);
      parsedId.season = metadata.seasons?.[0]?.season_number
        ? metadata.seasons[0].season_number.toString()
        : undefined;
      logger.debug(
        `Fetched season metadata for ${id} in ${getTimeTakenSincePoint(metadataStart)}:`,
        {
          season: parsedId.season,
        }
      );
    }

    logger.info(`Getting streams for ${id}`, {
      type,
      id,
      idType: parsedId.type,
      season: parsedId.season,
      episode: parsedId.episode,
      titleId: parsedId.id,
      sources: this.userData.sources,
    });

    const start = Date.now();
    const streamPromises = this.sourceHandlers.map((handler) =>
      handler.getStreams(parsedId, this.userData).catch((error) => {
        return [];
      })
    );

    const results = await Promise.all(streamPromises);
    const streams = results.flat();

    // filter out duplicate error streams and merge them
    const errorStreams = streams.filter((stream) =>
      stream.name?.startsWith('[❌')
    );

    const uniqueErrorStreams = errorStreams.filter(
      (stream, index, self) =>
        index === self.findIndex((t) => t.description === stream.description)
    );

    const mergedErrorStreams = uniqueErrorStreams.reduce<Stream[]>(
      (acc, stream) => {
        const existing = acc.find((s) => s.description === stream.description);
        if (existing) {
          existing.name += `\n${stream.name?.replace('[❌', '')}`;
        } else {
          acc.push(stream);
        }
        return acc;
      },
      []
    );

    const filteredStreams = streams.filter(
      (stream) => !stream.name?.startsWith('[❌')
    );
    const finalStreams = [...filteredStreams, ...mergedErrorStreams];

    logger.info(
      `Created ${finalStreams.length} streams for ${id} in ${getTimeTakenSincePoint(start)}`
    );
    return finalStreams;
  }
}
