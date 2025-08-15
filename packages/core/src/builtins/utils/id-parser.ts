import { TorboxSearchApiIdType } from '../torbox-search/search-api';

export interface ParsedId {
  type: TorboxSearchApiIdType;
  id: string;
  season?: string;
  episode?: string;
}

interface IdParserDefinition {
  type: TorboxSearchApiIdType;
  prefixes: string[];
  // Regex should have named capture groups:
  // - id: the base ID (required)
  // - season: the season number (optional)
  // - episode: the episode number (optional)
  regex: RegExp;
  format: (id: string) => string;
}

export class IdParser {
  private readonly ID_PARSERS: IdParserDefinition[] = [
    {
      type: 'imdb_id',
      prefixes: ['tt', 'imdb'],
      regex: /^(?:tt|imdb)[:-]?(?<id>\d+)(?::(?<season>\d+):(?<episode>\d+))?$/,
      format: (id) => `tt${id}`,
    },
    {
      type: 'mal_id',
      prefixes: ['mal'],
      regex: /^mal[:-]?(?<id>\d+)(?::(?<episode>\d+))?$/,
      format: (id) => id,
    },
    {
      type: 'thetvdb_id',
      prefixes: ['tvdb'],
      regex: /^tvdb[:-]?(?<id>\d+)(?::(?<season>\d+):(?<episode>\d+))?$/,
      format: (id) => id,
    },
    {
      type: 'tmdb',
      prefixes: ['tmdb'],
      regex: /^tmdb[:-]?(?<id>\d+)(?::(?<season>\d+):(?<episode>\d+))?$/,
      format: (id) => id,
    },
    {
      type: 'kitsu_id',
      prefixes: ['kitsu'],
      regex: /^kitsu[:-]?(?<id>\d+)(?::(?<episode>\d+))?$/,
      format: (id) => id,
    },
    {
      type: 'anilist_id',
      prefixes: ['anilist'],
      regex: /^anilist[:-]?(?<id>\d+)(?::(?<episode>\d+))?$/,
      format: (id) => id,
    },
    {
      type: 'anidb_id',
      prefixes: ['anidb', 'anidb_id', 'anidbid'],
      regex: /^(?:anidb|anidb_id|anidbid)[:-]?(?<id>\d+)(?::(?<episode>\d+))?$/,
      format: (id) => id,
    },
  ];

  constructor(private readonly supportedIdTypes: TorboxSearchApiIdType[]) {}

  public readonly supportedPrefixes = this.ID_PARSERS.filter((p) =>
    this.supportedIdTypes.includes(p.type)
  ).flatMap((p) => p.prefixes);

  public parse(stremioId: string): ParsedId | null {
    for (const parser of this.ID_PARSERS) {
      const match = stremioId.match(parser.regex);
      if (match?.groups) {
        const { id, season, episode } = match.groups;
        const parsedId: ParsedId = {
          type: parser.type,
          id: parser.format(id),
        };

        if (season) parsedId.season = season;
        if (episode) parsedId.episode = episode;

        return parsedId;
      }
    }

    return null;
  }
}
