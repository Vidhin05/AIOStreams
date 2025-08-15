import { z } from 'zod';
import { Cache, makeRequest, Env, TYPES } from '../utils';
import { Wrapper } from '../wrapper';
import { Metadata } from './utils';

const IMDBSuggestionSchema = z.object({
  d: z.array(
    z.object({
      i: z.object({
        height: z.number(),
        imageUrl: z.string(),
        width: z.number(),
      }),
      id: z.string(),
      l: z.string(), // title
      q: z.string(), // 'feature' |
      qid: z.string(), // e.g. 'movie',
      rank: z.number(),
      s: z.string(), // comma separated cast
      y: z.number(), // year
      yr: z.string().optional(),
    })
  ),
  q: z.string(),
  v: z.number(),
});

export class IMDBMetadata {
  private readonly titleCache: Cache<string, Metadata>;
  private readonly titleCacheTTL = 7 * 24 * 60 * 60;
  private readonly IMDB_SUGGESTION_API =
    'https://v3.sg.media-imdb.com/suggestion/a/';
  private readonly CINEMETA_URL = 'https://v3-cinemeta.strem.io/manifest.json';
  public constructor() {
    this.titleCache = Cache.getInstance('imdb-title');
  }

  public async getTitleAndYear(id: string, type: string): Promise<Metadata> {
    if (!id.startsWith('tt')) {
      throw new Error('IMDB ID must start with "tt"');
    }
    try {
      const imdbSuggestionData = await this.getImdbSuggestionData(id, type);
      return imdbSuggestionData;
    } catch (error) {
      const cinemetaData = await this.getCinemetaData(id, type);
      if (!cinemetaData.name || !cinemetaData.year) {
        throw new Error('Cinemeta data is missing title or year');
      }
      return {
        title: cinemetaData.name,
        year: Number(cinemetaData.releaseInfo?.toString().split('-')[0]),
      };
    }
  }

  private async getImdbSuggestionData(id: string, type: string) {
    const key = `${id}:${type}`;
    const cached = this.titleCache.get(key);
    if (cached) {
      return cached;
    }

    const url = `${this.IMDB_SUGGESTION_API}${id}.json`;
    const response = await makeRequest(url, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const data = IMDBSuggestionSchema.parse(await response.json());
    const item = data.d.find((item) => item.id === id);
    if (!item) {
      throw new Error(`IMDB item not found for id: ${id}`);
    }
    const title = item.l;
    const year = item.y;
    this.titleCache.set(key, { title, year }, this.titleCacheTTL);
    return { title, year };
  }

  private async getCinemetaData(id: string, type: string) {
    const cinemeta = new Wrapper({
      instanceId: 'cinemeta',
      preset: {
        id: 'custom',
        type: 'custom',
        options: {
          id: id,
        },
      },
      manifestUrl: this.CINEMETA_URL,
      name: 'Cinemeta',
      timeout: 1000,
      enabled: true,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const meta = await cinemeta.getMeta(type, id);
    return meta;
  }
}
