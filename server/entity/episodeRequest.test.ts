import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('EpisodeRequest entity', () => {
  setupTestDb();

  it('persists episodes as children of a season request and cascades', async () => {
    const seasonRepo = getRepository(SeasonRequest);
    const season = new SeasonRequest({
      seasonNumber: 1,
      status: MediaRequestStatus.PENDING,
      episodes: [
        new EpisodeRequest({
          episodeNumber: 5,
          status: MediaRequestStatus.PENDING,
        }),
      ],
    });
    const saved = await seasonRepo.save(season);

    const reloaded = await seasonRepo.findOneOrFail({
      where: { id: saved.id },
      relations: { episodes: true },
    });
    assert.equal(reloaded.episodes.length, 1);
    assert.equal(reloaded.episodes[0].episodeNumber, 5);

    // cascade delete
    await seasonRepo.remove(reloaded);
    const orphans = await getRepository(EpisodeRequest).find();
    assert.equal(orphans.length, 0);
  });
});
