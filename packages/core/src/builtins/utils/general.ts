export function calculateAbsoluteEpisode(
  season: string,
  episode: string,
  seasons: { number: string; episodes: number }[]
): string {
  const episodeNumber = Number(episode);
  let totalEpisodesBeforeSeason = 0;

  for (const s of seasons.filter((s) => s.number !== '0')) {
    if (s.number === season) break;
    totalEpisodesBeforeSeason += s.episodes;
  }

  return (totalEpisodesBeforeSeason + episodeNumber).toString();
}
