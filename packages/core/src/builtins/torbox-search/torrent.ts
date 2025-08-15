import { z } from 'zod';
import { TorBoxSearchApiDataSchema } from './schemas';
import { ServiceId } from '../../utils';
import { DebridFile } from './debrid-service';

export interface Torrent {
  hash: string;
  magnet?: string;
  title: string;
  fileIdx?: number;
  size: number;
  indexer: string;
  age?: string;
  seeders?: number;
  type: 'torrent' | 'usenet';
  nzb?: string;
  userSearch?: boolean;
  cached?: boolean;
  availableFiles?: DebridFile[];
}

export function convertDataToTorrents(
  data: z.infer<typeof TorBoxSearchApiDataSchema>['torrents']
): Torrent[] {
  return (data || []).map((file) => ({
    hash: file.hash,
    magnet: file.magnet ?? undefined,
    title: file.raw_title,
    size: file.size,
    indexer: file.tracker,
    age: file.age,
    type: file.type,
    userSearch: file.user_search,
    seeders:
      file.last_known_seeders !== -1 ? file.last_known_seeders : undefined,
    nzb: file.nzb ?? undefined,
    cached: file.cached ?? undefined,
  }));
}
