import { AnimeKitsuPreset } from '../presets/animeKitsu';
import { Cache } from '../utils';
import { Wrapper } from '../wrapper';
import { Metadata } from './utils';
import { IdParser, ParsedId } from '../builtins/utils/id-parser';
import z from 'zod';

// kitsu, mal, anilist, anidb

export class KitsuMetadata {
  public constructor() {}

  public async getMetadata(id: ParsedId, type: string): Promise<Metadata> {
    const [kitsuAddon] = await AnimeKitsuPreset.generateAddons(
      {
        sortCriteria: { global: [] },
        formatter: { id: 'gdrive' },
        presets: [],
      },
      {}
    );

    if (!['kitsu_id', 'mal_id', 'anilist_id', 'anidb_id'].includes(id.type)) {
      throw new Error('Invalid ID type');
    }
    const meta = await new Wrapper(kitsuAddon).getMeta(
      type,
      `${id.type.replace('_id', '')}:${id.id}`
    );
    if (!meta.name || !meta.releaseInfo) {
      throw new Error('Kitsu metadata is missing title or year');
    }

    let season: number | undefined;
    const aliasesParse = z.array(z.string()).safeParse((meta as any).aliases);
    if (aliasesParse.success) {
      season = aliasesParse.data
        .map((alias) => alias.match(/Season (\d+)/i))
        .filter((match) => match !== null)
        .map((match) => match![1])
        .map(Number)
        .find((s) => !isNaN(s));
    }
    if (!season && z.string().safeParse(meta.slug).success) {
      const seasonMatch = z
        .string()
        .parse(meta.slug)
        .match(/-(\d+)$/);
      if (seasonMatch) {
        season = Number(seasonMatch[1]);
      }
    }

    return {
      title: meta.name,
      titles: [meta.name, ...(meta.aliases ? (meta.aliases as string[]) : [])],
      year: Number(meta.releaseInfo?.toString().split('-')[0]),
      seasons: season
        ? [
            {
              season_number: season,
              episode_count: meta.videos?.length || 0,
            },
          ]
        : undefined,
    };
  }
}
