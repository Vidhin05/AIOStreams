export interface Metadata {
  title: string;
  titles?: string[];
  year: number;
  seasons?: {
    season_number: number;
    episode_count: number;
  }[];
}
