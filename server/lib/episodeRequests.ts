export type EpisodeTarget = { seasonNumber: number; episodeNumber: number };

type SeasonLike = {
  seasonNumber: number;
  episodes?: { episodeNumber: number }[];
};

export function splitSeasonRequests(seasons: SeasonLike[]): {
  fullSeasonNumbers: number[];
  episodeTargets: EpisodeTarget[];
} {
  const fullSeasonNumbers: number[] = [];
  const episodeTargets: EpisodeTarget[] = [];

  for (const season of seasons) {
    if (season.episodes && season.episodes.length > 0) {
      for (const episode of season.episodes) {
        episodeTargets.push({
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber,
        });
      }
    } else {
      fullSeasonNumbers.push(season.seasonNumber);
    }
  }

  return { fullSeasonNumbers, episodeTargets };
}

export function resolveEpisodeIds(
  sonarrEpisodes: { seasonNumber: number; episodeNumber: number; id: number }[],
  targets: EpisodeTarget[]
): number[] {
  const ids: number[] = [];
  for (const target of targets) {
    const match = sonarrEpisodes.find(
      (ep) =>
        ep.seasonNumber === target.seasonNumber &&
        ep.episodeNumber === target.episodeNumber
    );
    if (match && !ids.includes(match.id)) {
      ids.push(match.id);
    }
  }
  return ids;
}
