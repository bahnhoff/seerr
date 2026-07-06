import {
  resolveEpisodeIds,
  splitSeasonRequests,
} from '@server/lib/episodeRequests';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('splitSeasonRequests', () => {
  it('treats seasons without episodes as full seasons', () => {
    const out = splitSeasonRequests([
      { seasonNumber: 2 },
      { seasonNumber: 3, episodes: [] },
    ]);
    assert.deepEqual(out.fullSeasonNumbers, [2, 3]);
    assert.deepEqual(out.episodeTargets, []);
  });

  it('extracts episode targets and excludes those seasons from full seasons', () => {
    const out = splitSeasonRequests([
      {
        seasonNumber: 1,
        episodes: [{ episodeNumber: 5 }, { episodeNumber: 6 }],
      },
      { seasonNumber: 2 },
    ]);
    assert.deepEqual(out.fullSeasonNumbers, [2]);
    assert.deepEqual(out.episodeTargets, [
      { seasonNumber: 1, episodeNumber: 5 },
      { seasonNumber: 1, episodeNumber: 6 },
    ]);
  });
});

describe('resolveEpisodeIds', () => {
  const episodes = [
    { seasonNumber: 1, episodeNumber: 5, id: 101 },
    { seasonNumber: 1, episodeNumber: 6, id: 102 },
    { seasonNumber: 2, episodeNumber: 1, id: 201 },
  ];

  it('maps (season, episode) targets to Sonarr ids', () => {
    assert.deepEqual(
      resolveEpisodeIds(episodes, [{ seasonNumber: 1, episodeNumber: 6 }]),
      [102]
    );
  });

  it('ignores targets with no matching episode', () => {
    assert.deepEqual(
      resolveEpisodeIds(episodes, [{ seasonNumber: 9, episodeNumber: 9 }]),
      []
    );
  });
});
