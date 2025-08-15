import { Headers } from 'undici';
import { Env, Cache, TYPES, makeRequest } from '../utils';
export type ExternalIdType = 'imdb' | 'tmdb' | 'tvdb';

interface ExternalId {
  type: ExternalIdType;
  value: string;
}

const API_BASE_URL = 'https://api.themoviedb.org/3';
const FIND_BY_ID_PATH = '/find';
const MOVIE_DETAILS_PATH = '/movie';
const TV_DETAILS_PATH = '/tv';
const ALTERNATIVE_TITLES_PATH = '/alternative_titles';

// Cache TTLs in seconds
const ID_CACHE_TTL = 24 * 60 * 60; // 24 hours
const TITLE_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days
const ACCESS_TOKEN_CACHE_TTL = 2 * 24 * 60 * 60; // 2 day

export interface TMDBMetadataResponse {
  titles: string[];
  year: string;
  seasons?: {
    season_number: number;
    episode_count: number;
  }[];
}

export class TMDBMetadata {
  private readonly TMDB_ID_REGEX = /^(?:tmdb)[-:](\d+)(?::\d+:\d+)?$/;
  private readonly TVDB_ID_REGEX = /^(?:tvdb)[-:](\d+)(?::\d+:\d+)?$/;
  private readonly IMDB_ID_REGEX = /^(?:tt)(\d+)(?::\d+:\d+)?$/;
  private static readonly idCache: Cache<string, string> = Cache.getInstance<
    string,
    string
  >('tmdb_id_conversion');
  private static readonly metadataCache: Cache<string, TMDBMetadataResponse> =
    Cache.getInstance<string, TMDBMetadataResponse>('tmdb_metadata');
  private readonly accessToken: string | undefined;
  private readonly apiKey: string | undefined;
  private static readonly validationCache: Cache<string, boolean> =
    Cache.getInstance<string, boolean>('tmdb_validation');
  public constructor(auth?: { accessToken?: string; apiKey?: string }) {
    if (
      !auth?.accessToken &&
      !Env.TMDB_ACCESS_TOKEN &&
      !auth?.apiKey &&
      !Env.TMDB_API_KEY
    ) {
      throw new Error('TMDB Access Token or API Key is not set');
    }
    if (auth?.apiKey || Env.TMDB_API_KEY) {
      this.apiKey = auth?.apiKey || Env.TMDB_API_KEY;
    } else if (auth?.accessToken || Env.TMDB_ACCESS_TOKEN) {
      this.accessToken = auth?.accessToken || Env.TMDB_ACCESS_TOKEN;
    }
  }

  private getHeaders(): Headers {
    const headers = new Headers();
    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    headers.set('Content-Type', 'application/json');
    return headers;
  }

  private parseExternalId(id: string): ExternalId | null {
    if (this.TMDB_ID_REGEX.test(id)) {
      const match = id.match(this.TMDB_ID_REGEX);
      return match ? { type: 'tmdb', value: match[1] } : null;
    }
    if (this.IMDB_ID_REGEX.test(id)) {
      const match = id.match(this.IMDB_ID_REGEX);
      return match ? { type: 'imdb', value: `tt${match[1]}` } : null;
    }
    if (this.TVDB_ID_REGEX.test(id)) {
      const match = id.match(this.TVDB_ID_REGEX);
      return match ? { type: 'tvdb', value: match[1] } : null;
    }
    return null;
  }

  private async convertToTmdbId(
    id: ExternalId,
    type: (typeof TYPES)[number]
  ): Promise<string> {
    if (id.type === 'tmdb') {
      return id.value;
    }

    // Check cache first
    const cacheKey = `${id.type}:${id.value}:${type}`;
    const cachedId = TMDBMetadata.idCache.get(cacheKey);
    if (cachedId) {
      return cachedId;
    }

    const url = new URL(API_BASE_URL + FIND_BY_ID_PATH + `/${id.value}`);
    url.searchParams.set('external_source', `${id.type}_id`);
    this.addSearchParams(url);
    const response = await makeRequest(url.toString(), {
      timeout: 10000,
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`${response.status} - ${response.statusText}`);
    }

    const data: any = await response.json();
    const results = type === 'movie' ? data.movie_results : data.tv_results;
    const meta = results?.[0];

    if (!meta) {
      throw new Error(`No ${type} metadata found for ID: ${id.value}`);
    }

    const tmdbId = meta.id.toString();
    // Cache the result
    TMDBMetadata.idCache.set(cacheKey, tmdbId, ID_CACHE_TTL);
    return tmdbId;
  }

  private parseReleaseDate(releaseDate: string): string {
    const date = new Date(releaseDate);
    return date.getFullYear().toString();
  }

  public async getMetadata(
    id: string,
    type: (typeof TYPES)[number]
  ): Promise<TMDBMetadataResponse> {
    if (!['movie', 'series', 'anime'].includes(type)) {
      throw new Error(`Invalid type: ${type}`);
    }

    const externalId = this.parseExternalId(id);
    if (!externalId) {
      throw new Error(
        'Invalid ID format. Must be TMDB (tmdb:123) or IMDB (tt123) or TVDB (tvdb:123) format'
      );
    }

    const tmdbId = await this.convertToTmdbId(externalId, type);

    // Check cache first
    const cacheKey = `${tmdbId}:${type}`;
    const cachedMetadata = TMDBMetadata.metadataCache.get(cacheKey);
    if (cachedMetadata) {
      return cachedMetadata;
    }

    // Fetch primary title from details endpoint
    const detailsUrl = new URL(
      API_BASE_URL +
        (type === 'movie' ? MOVIE_DETAILS_PATH : TV_DETAILS_PATH) +
        `/${tmdbId}`
    );
    this.addSearchParams(detailsUrl);
    const detailsResponse = await makeRequest(detailsUrl.toString(), {
      timeout: 10000,
      headers: this.getHeaders(),
    });

    if (!detailsResponse.ok) {
      throw new Error(`Failed to fetch details: ${detailsResponse.statusText}`);
    }

    const detailsData: any = await detailsResponse.json();
    const primaryTitle =
      type === 'movie' ? detailsData.title : detailsData.name;
    const year = this.parseReleaseDate(
      type === 'movie' ? detailsData.release_date : detailsData.first_air_date
    );
    const seasons =
      type === 'series'
        ? detailsData.seasons.map((season: any) => ({
            season_number: season.season_number,
            episode_count: season.episode_count,
          }))
        : undefined;

    // Fetch alternative titles
    const altTitlesUrl = new URL(
      API_BASE_URL +
        (type === 'movie' ? MOVIE_DETAILS_PATH : TV_DETAILS_PATH) +
        `/${tmdbId}` +
        ALTERNATIVE_TITLES_PATH
    );
    this.addSearchParams(altTitlesUrl);
    const altTitlesResponse = await makeRequest(altTitlesUrl.toString(), {
      timeout: 10000,
      headers: this.getHeaders(),
    });

    if (!altTitlesResponse.ok) {
      throw new Error(
        `Failed to fetch alternative titles: ${altTitlesResponse.statusText}`
      );
    }

    const altTitlesData: any = await altTitlesResponse.json();
    const alternativeTitles =
      type === 'movie'
        ? altTitlesData.titles.map((title: any) => title.title)
        : altTitlesData.results.map((title: any) => title.title);

    // Combine primary title with alternative titles, ensuring no duplicates
    const allTitles = [primaryTitle, ...alternativeTitles];
    const uniqueTitles = [...new Set(allTitles)];
    const metadata: TMDBMetadataResponse = {
      titles: uniqueTitles,
      year,
      seasons,
    };
    // Cache the result
    TMDBMetadata.metadataCache.set(cacheKey, metadata, TITLE_CACHE_TTL);
    return metadata;
  }

  private addSearchParams(url: URL) {
    if (this.apiKey) {
      url.searchParams.set('api_key', this.apiKey);
    }
  }

  public async validateAccessToken() {
    const cacheKey = this.accessToken || this.apiKey;
    if (!cacheKey) {
      throw new Error('TMDB Access Token or API Key is not set');
    }
    const cachedResult = TMDBMetadata.validationCache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }
    const url = new URL(API_BASE_URL + '/authentication');
    this.addSearchParams(url);
    const validationResponse = await makeRequest(url.toString(), {
      timeout: 10000,
      headers: this.getHeaders(),
    });
    if (!validationResponse.ok) {
      throw new Error(
        `Failed to validate TMDB access token: ${validationResponse.statusText}`
      );
    }
    const validationData: any = await validationResponse.json();
    const isValid = validationData.success;
    TMDBMetadata.validationCache.set(cacheKey, isValid, ACCESS_TOKEN_CACHE_TTL);
    return isValid;
  }
}
