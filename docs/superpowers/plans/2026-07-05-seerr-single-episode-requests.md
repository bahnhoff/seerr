# Single-Episode Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users request individual TV episodes in Seerr's request modal so Sonarr downloads only the selected episodes instead of the whole season.

**Architecture:** Model episodes as first-class rows (`EpisodeRequest`, child of `SeasonRequest`; empty children = "whole season" = today's behavior). The request API gains an optional parallel `episodes` field (the existing `seasons` field is untouched → backward-compatible). The TypeORM subscriber that dispatches approved TV requests to Sonarr splits seasons into "full" vs "episode-partial"; full seasons keep today's whole-season monitoring, episode-partial seasons are monitored and searched at the episode level via new Sonarr client methods. Two pure helper functions hold the branching logic so it is unit-testable without a DB or Sonarr. The frontend modal gains per-season expanders with episode checkboxes.

**Tech Stack:** TypeScript, Node/Express, TypeORM (SQLite default + Postgres), Next.js/React (SWR), `node:test` runner, pnpm.

## Global Constraints

- Base: Seerr `v3.3.0`, branch `feature/single-episode-requests`. Copy the surrounding code's style exactly.
- Backward compatibility is mandatory: existing `seasons: number[] | 'all'` requests must behave **identically**. Episode support is additive.
- Test runner is **`node:test`**, NOT jest. Run all server tests: `pnpm test`. Run one file: `node server/test/index.mts <path-to-test>`. Tests use a real in-memory SQLite with `synchronize: true` (schema auto-derived from entities), so new entities work in tests **without** a migration; migrations are only needed for prod (both `sqlite/` and `postgres/`).
- There is **no frontend test harness** in this repo. Frontend tasks are verified with `pnpm typecheck:client`, `pnpm lint`, `pnpm build:next`, and manual E2E — do NOT introduce jest or a new test framework.
- `MediaRequestStatus.PENDING === 1` (used as the `status` column default). Confirm in `server/constants/media.ts` before writing migration SQL.
- Naming: TypeORM uses snake_case table names (`season_request`, so the new table is `episode_request`; the FK column derived from a `seasonRequest` relation property is `seasonRequestId`).
- Lint/typecheck must pass before every commit: `pnpm lint && pnpm typecheck:server`.

---

## File Structure

**New files:**
- `server/lib/episodeRequests.ts` — pure helpers: `EpisodeTarget` type, `splitSeasonRequests()`, `resolveEpisodeIds()`. One responsibility: episode-request branching logic, no I/O.
- `server/lib/episodeRequests.test.ts` — unit tests for the two pure helpers.
- `server/entity/EpisodeRequest.ts` — the episode-request entity (child of `SeasonRequest`).
- `server/entity/episodeRequest.test.ts` — persistence/cascade test for the entity relation.
- `server/migration/sqlite/<timestamp>-AddEpisodeRequest.ts` — SQLite migration (create `episode_request`).
- `server/migration/postgres/<timestamp>-AddEpisodeRequest.ts` — Postgres migration (create `episode_request`).

**Modified files:**
- `server/entity/SeasonRequest.ts` — add `episodes` OneToMany relation.
- `server/interfaces/api/requestInterfaces.ts` — add optional `episodes` to `MediaRequestBody`.
- `server/entity/MediaRequest.ts` — in `request()`, build `SeasonRequest`s (with `EpisodeRequest` children) from `body.episodes`.
- `server/routes/request.test.ts` — API test for the new `episodes` body field.
- `server/api/servarr/sonarr.ts` — add `searchEpisodes()` and `monitorAndSearchEpisodes()`.
- `server/subscriber/MediaRequestSubscriber.ts` — split full vs episode-partial seasons; drive episode-level monitor + search.
- `src/components/RequestModal/TvRequestModal.tsx` — per-season expander, episode checkboxes, `episodes` in the POST payload.

---

## Task 1: Pure branching helpers (`splitSeasonRequests`, `resolveEpisodeIds`)

**Files:**
- Create: `server/lib/episodeRequests.ts`
- Test: `server/lib/episodeRequests.test.ts`

**Interfaces:**
- Produces:
  - `type EpisodeTarget = { seasonNumber: number; episodeNumber: number }`
  - `splitSeasonRequests(seasons: { seasonNumber: number; episodes?: { episodeNumber: number }[] }[]): { fullSeasonNumbers: number[]; episodeTargets: EpisodeTarget[] }` — a season whose `episodes` array is missing or empty is a "full" season (its number goes to `fullSeasonNumbers`); a season with episodes contributes one `EpisodeTarget` per episode and its number does NOT go to `fullSeasonNumbers`.
  - `resolveEpisodeIds(sonarrEpisodes: { seasonNumber: number; episodeNumber: number; id: number }[], targets: EpisodeTarget[]): number[]` — returns the Sonarr `id`s whose (seasonNumber, episodeNumber) match a target; de-duplicated; order follows `targets`.

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/episodeRequests.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveEpisodeIds,
  splitSeasonRequests,
} from '@server/lib/episodeRequests';

describe('splitSeasonRequests', () => {
  it('treats seasons without episodes as full seasons', () => {
    const out = splitSeasonRequests([{ seasonNumber: 2 }, { seasonNumber: 3, episodes: [] }]);
    assert.deepEqual(out.fullSeasonNumbers, [2, 3]);
    assert.deepEqual(out.episodeTargets, []);
  });

  it('extracts episode targets and excludes those seasons from full seasons', () => {
    const out = splitSeasonRequests([
      { seasonNumber: 1, episodes: [{ episodeNumber: 5 }, { episodeNumber: 6 }] },
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node server/test/index.mts server/lib/episodeRequests.test.ts`
Expected: FAIL — `Cannot find module '@server/lib/episodeRequests'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// server/lib/episodeRequests.ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node server/test/index.mts server/lib/episodeRequests.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/lib/episodeRequests.ts server/lib/episodeRequests.test.ts
git commit -m "feat(episodes): pure helpers for splitting season requests and resolving Sonarr episode ids"
```

---

## Task 2: `EpisodeRequest` entity + `SeasonRequest` relation

**Files:**
- Create: `server/entity/EpisodeRequest.ts`
- Modify: `server/entity/SeasonRequest.ts`
- Test: `server/entity/episodeRequest.test.ts`

**Interfaces:**
- Consumes: `MediaRequestStatus` from `@server/constants/media`; `SeasonRequest` (default export) from `./SeasonRequest`.
- Produces: `EpisodeRequest` entity with `{ id, episodeNumber, status, seasonRequest, createdAt, updatedAt }`; `SeasonRequest.episodes: EpisodeRequest[]` (eager, cascade).

- [ ] **Step 1: Write the failing test**

```ts
// server/entity/episodeRequest.test.ts
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { setupTestDb } from '@server/test/db';

describe('EpisodeRequest entity', () => {
  setupTestDb();

  it('persists episodes as children of a season request and cascades', async () => {
    const seasonRepo = getRepository(SeasonRequest);
    const season = new SeasonRequest({
      seasonNumber: 1,
      status: MediaRequestStatus.PENDING,
      episodes: [
        new EpisodeRequest({ episodeNumber: 5, status: MediaRequestStatus.PENDING }),
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node server/test/index.mts server/entity/episodeRequest.test.ts`
Expected: FAIL — `Cannot find module '@server/entity/EpisodeRequest'`.

- [ ] **Step 3: Create the entity**

```ts
// server/entity/EpisodeRequest.ts
import { MediaRequestStatus } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import SeasonRequest from './SeasonRequest';

@Entity()
class EpisodeRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public episodeNumber: number;

  @Column({ type: 'int', default: MediaRequestStatus.PENDING })
  public status: MediaRequestStatus;

  @ManyToOne(() => SeasonRequest, (seasonRequest) => seasonRequest.episodes, {
    onDelete: 'CASCADE',
  })
  @Index()
  public seasonRequest: SeasonRequest;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<EpisodeRequest>) {
    Object.assign(this, init);
  }
}

export default EpisodeRequest;
```

- [ ] **Step 4: Add the relation to `SeasonRequest`**

In `server/entity/SeasonRequest.ts`, add the `OneToMany` import and the `episodes` property. Add `OneToMany` to the existing `typeorm` import list, add `import EpisodeRequest from './EpisodeRequest';`, and insert this property after the `status` column:

```ts
  @OneToMany(() => EpisodeRequest, (episode) => episode.seasonRequest, {
    eager: true,
    cascade: true,
  })
  public episodes: EpisodeRequest[];
```

- [ ] **Step 5: Run the test + typecheck to verify it passes**

Run: `node server/test/index.mts server/entity/episodeRequest.test.ts && pnpm typecheck:server`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/entity/EpisodeRequest.ts server/entity/SeasonRequest.ts server/entity/episodeRequest.test.ts
git commit -m "feat(episodes): add EpisodeRequest entity as child of SeasonRequest"
```

---

## Task 3: Request API accepts `episodes`

**Files:**
- Modify: `server/interfaces/api/requestInterfaces.ts`
- Modify: `server/entity/MediaRequest.ts` (the static `request()` method, ~lines 392–522)
- Test: `server/routes/request.test.ts`

**Interfaces:**
- Consumes: `EpisodeRequest` entity (Task 2); `MediaRequestBody`.
- Produces: `MediaRequestBody.episodes?: { seasonNumber: number; episodes: number[] }[]`; `MediaRequest.request()` now creates `SeasonRequest`s carrying `EpisodeRequest` children when `body.episodes` is present.

- [ ] **Step 1: Add the body field**

In `server/interfaces/api/requestInterfaces.ts`, add to the `MediaRequestBody` type (after `seasons?: number[] | 'all';`):

```ts
  episodes?: { seasonNumber: number; episodes: number[] }[];
```

- [ ] **Step 2: Write the failing API test**

Add to `server/routes/request.test.ts` (follow the existing describe/login pattern already in the file; reuse its logged-in agent + a seeded `Media`). Add this test inside the existing top-level `describe`:

```ts
it('creates episode-level season requests from body.episodes', async () => {
  // `agent` = supertest agent logged in as admin; `tmdbId` = a seeded tv Media id.
  // (Match the existing tests' setup in this file for `agent` and media seeding.)
  const res = await agent
    .post('/api/v1/request')
    .send({ mediaType: 'tv', mediaId: tmdbId, episodes: [{ seasonNumber: 1, episodes: [5] }] })
    .expect(201);

  const created = await getRepository(MediaRequest).findOneOrFail({
    where: { id: res.body.id },
    relations: { seasons: { episodes: true } },
  });
  assert.equal(created.seasons.length, 1);
  assert.equal(created.seasons[0].seasonNumber, 1);
  assert.equal(created.seasons[0].episodes.length, 1);
  assert.equal(created.seasons[0].episodes[0].episodeNumber, 5);
});
```

> Note: `sendToSonarr` early-returns in tests (no Sonarr configured), so this test exercises only persistence. If the file does not already expose a helper for seeding a tv `Media` + logging in, first read `server/routes/request.test.ts` top-to-bottom to reuse its existing setup verbatim rather than duplicating it.

- [ ] **Step 3: Run to verify it fails**

Run: `node server/test/index.mts server/routes/request.test.ts`
Expected: FAIL — `created.seasons` empty / length 0 (episodes not yet handled).

- [ ] **Step 4: Handle `episodes` in `MediaRequest.request()`**

First read `server/entity/MediaRequest.ts:392-522` to see how the existing `SeasonRequest[]` is assembled (the `finalSeasons.map((sn) => new SeasonRequest({ seasonNumber: sn, status }))` block) and which local variable holds it before the `new MediaRequest({ ... seasons })` construction.

Then, immediately after that season array is built, append episode-based season requests. Insert:

```ts
    // Episode-level requests (parallel to whole-season `seasons`).
    const episodeSeasonRequests = (requestBody.episodes ?? [])
      .filter((sel) => sel.episodes.length > 0)
      .map(
        (sel) =>
          new SeasonRequest({
            seasonNumber: sel.seasonNumber,
            status: /* same status expression used for the whole-season requests above */,
            episodes: sel.episodes.map(
              (episodeNumber) =>
                new EpisodeRequest({ episodeNumber, status: /* same status */ }),
            ),
          }),
      );
```

Then concatenate `episodeSeasonRequests` into the season list passed to `new MediaRequest({ ..., seasons: [...seasonRequests, ...episodeSeasonRequests] })`. Add `import EpisodeRequest from './EpisodeRequest';` at the top. Use the exact same `status` expression the surrounding code uses for whole-season requests (auto-approval logic) — copy it verbatim; do not invent a new status rule.

Also guard the "no seasons" error: if `requestBody.seasons` is empty/absent but `requestBody.episodes` has entries, the request is still valid — ensure the `NoSeasonsAvailableError` throw accounts for `episodeSeasonRequests.length` too.

- [ ] **Step 5: Run to verify it passes**

Run: `node server/test/index.mts server/routes/request.test.ts && pnpm typecheck:server`
Expected: PASS (including the pre-existing tests — regression guard); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/interfaces/api/requestInterfaces.ts server/entity/MediaRequest.ts server/routes/request.test.ts
git commit -m "feat(episodes): accept episode-level selections in the request API"
```

---

## Task 4: Sonarr client — `searchEpisodes` + `monitorAndSearchEpisodes`

**Files:**
- Modify: `server/api/servarr/sonarr.ts`

**Interfaces:**
- Consumes: existing `getEpisodes(seriesId): Promise<EpisodeResult[]>`, `monitorEpisodes(episodeIds: number[]): Promise<void>`, base `runCommand(name, options)`; `resolveEpisodeIds`, `EpisodeTarget` from `@server/lib/episodeRequests`.
- Produces:
  - `searchEpisodes(episodeIds: number[]): Promise<void>` — issues the Sonarr `EpisodeSearch` command.
  - `monitorAndSearchEpisodes(seriesId: number, targets: EpisodeTarget[], retries?: number, delayMs?: number): Promise<void>` — polls `getEpisodes` until the target episodes resolve (Sonarr populates episode metadata asynchronously after a series is added), then monitors and searches exactly those episodes.

- [ ] **Step 1: Add `searchEpisodes`**

Mirror `searchSeries` (which does `await this.runCommand('MissingEpisodeSearch', { seriesId })`). Add near it:

```ts
  public async searchEpisodes(episodeIds: number[]): Promise<void> {
    if (episodeIds.length === 0) {
      return;
    }
    await this.runCommand('EpisodeSearch', { episodeIds });
  }
```

- [ ] **Step 2: Add `monitorAndSearchEpisodes`**

Add this method (uses `resolveEpisodeIds` from Task 1; imports `resolveEpisodeIds` and `EpisodeTarget` at the top of `sonarr.ts`):

```ts
  public async monitorAndSearchEpisodes(
    seriesId: number,
    targets: EpisodeTarget[],
    retries = 6,
    delayMs = 5000
  ): Promise<void> {
    if (targets.length === 0) {
      return;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      const episodes = await this.getEpisodes(seriesId);
      const episodeIds = resolveEpisodeIds(episodes, targets);

      if (episodeIds.length === targets.length) {
        await this.monitorEpisodes(episodeIds);
        await this.searchEpisodes(episodeIds);
        return;
      }

      // Sonarr may not have refreshed episode metadata yet; wait and retry.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // Final attempt: monitor/search whatever resolved, and warn about the rest.
    const episodes = await this.getEpisodes(seriesId);
    const episodeIds = resolveEpisodeIds(episodes, targets);
    if (episodeIds.length > 0) {
      await this.monitorEpisodes(episodeIds);
      await this.searchEpisodes(episodeIds);
    }
    if (episodeIds.length < targets.length) {
      logger.warn('Some requested episodes could not be resolved in Sonarr', {
        label: 'Sonarr',
        seriesId,
        requested: targets.length,
        resolved: episodeIds.length,
      });
    }
  }
```

(`logger` is already imported in `sonarr.ts` — confirm and reuse the existing import.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck:server`
Expected: clean. (No unit test here — construction of `SonarrAPI` requires live settings; the branching logic it relies on is already unit-tested in Task 1, and end-to-end behavior is verified manually in Task 8.)

- [ ] **Step 4: Commit**

```bash
git add server/api/servarr/sonarr.ts
git commit -m "feat(episodes): add searchEpisodes and monitorAndSearchEpisodes to Sonarr client"
```

---

## Task 5: Subscriber dispatches episode-level requests to Sonarr

**Files:**
- Modify: `server/subscriber/MediaRequestSubscriber.ts` (`sendToSonarr`, ~lines 477–760; options built ~703–716)

**Interfaces:**
- Consumes: `splitSeasonRequests` from `@server/lib/episodeRequests`; `sonarrApi.monitorAndSearchEpisodes` (Task 4); existing `AddSeriesOptions` construction.
- Produces: episode-partial seasons are excluded from whole-season monitoring and instead monitored+searched at episode level after the series is added.

- [ ] **Step 1: Read the current dispatch**

Read `server/subscriber/MediaRequestSubscriber.ts:700-760` to see the `sonarrSeriesOptions` object and the `sonarrApi.addSeries(...).then(...).catch(...)` chain exactly.

- [ ] **Step 2: Compute the split and change the seasons passed to Sonarr**

Immediately before the `const sonarrSeriesOptions: AddSeriesOptions = { ... }` literal, add:

```ts
        const { fullSeasonNumbers, episodeTargets } = splitSeasonRequests(
          entity.seasons
        );
```

Then change the options' `seasons` line from:

```ts
          seasons: entity.seasons.map((season) => season.seasonNumber),
```
to:
```ts
          seasons: fullSeasonNumbers,
```

Add `import { splitSeasonRequests } from '@server/lib/episodeRequests';` at the top.

- [ ] **Step 3: Trigger episode monitor/search after the series is added**

In the existing `.then((sonarrSeries) => { ... })` handler of `sonarrApi.addSeries(...)` (where `sonarrSeries` is the returned `SonarrSeries` with `.id`), add, after the existing success handling:

```ts
            if (episodeTargets.length > 0) {
              sonarrApi
                .monitorAndSearchEpisodes(sonarrSeries.id, episodeTargets)
                .catch((e) => {
                  logger.error('Failed to monitor/search requested episodes', {
                    label: 'Sonarr',
                    errorMessage: e.message,
                    mediaId: entity.media.id,
                  });
                });
            }
```

Match the argument name of the `.then()` callback to whatever the existing code uses (it may be named `sonarrSeries` or similar); if the current `.then()` discards the value, change it to capture the resolved series. `logger` is already imported in this file.

- [ ] **Step 4: Typecheck + full server test suite (regression guard)**

Run: `pnpm typecheck:server && pnpm test`
Expected: typecheck clean; all existing tests still pass (episode dispatch is a no-op in tests because Sonarr is not configured).

- [ ] **Step 5: Commit**

```bash
git add server/subscriber/MediaRequestSubscriber.ts
git commit -m "feat(episodes): dispatch episode-partial season requests to Sonarr at episode level"
```

---

## Task 6: Database migrations (SQLite + Postgres)

**Files:**
- Create: `server/migration/sqlite/<timestamp>-AddEpisodeRequest.ts`
- Create: `server/migration/postgres/<timestamp>-AddEpisodeRequest.ts`

**Interfaces:** none (schema only). Tests do not run migrations (they use `synchronize: true`), so this task is verified by running the migration against a scratch DB.

- [ ] **Step 1: Confirm the status default**

Read `server/constants/media.ts` and confirm `MediaRequestStatus.PENDING === 1`. Use that integer as the column default below.

- [ ] **Step 2: Create the SQLite migration**

Generate the timestamped filename with `pnpm migration:create server/migration/sqlite/AddEpisodeRequest`, then replace its body with:

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeRequest<TIMESTAMP> implements MigrationInterface {
  name = 'AddEpisodeRequest<TIMESTAMP>';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "episode_request" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"episodeNumber" integer NOT NULL, ` +
        `"status" integer NOT NULL DEFAULT (1), ` +
        `"createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), ` +
        `"seasonRequestId" integer, ` +
        `CONSTRAINT "FK_episode_request_season" FOREIGN KEY ("seasonRequestId") ` +
        `REFERENCES "season_request" ("id") ON DELETE CASCADE ON UPDATE NO ACTION` +
        `)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_episode_request_season" ON "episode_request" ("seasonRequestId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_episode_request_season"`);
    await queryRunner.query(`DROP TABLE "episode_request"`);
  }
}
```

Replace `<TIMESTAMP>` with the epoch-millis prefix the filename received.

- [ ] **Step 3: Create the Postgres migration**

`pnpm migration:create server/migration/postgres/AddEpisodeRequest`, then:

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeRequest<TIMESTAMP> implements MigrationInterface {
  name = 'AddEpisodeRequest<TIMESTAMP>';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "episode_request" (` +
        `"id" SERIAL NOT NULL, ` +
        `"episodeNumber" integer NOT NULL, ` +
        `"status" integer NOT NULL DEFAULT 1, ` +
        `"createdAt" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"updatedAt" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"seasonRequestId" integer, ` +
        `CONSTRAINT "PK_episode_request" PRIMARY KEY ("id")` +
        `)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_episode_request_season" ON "episode_request" ("seasonRequestId")`
    );
    await queryRunner.query(
      `ALTER TABLE "episode_request" ADD CONSTRAINT "FK_episode_request_season" ` +
        `FOREIGN KEY ("seasonRequestId") REFERENCES "season_request"("id") ` +
        `ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "episode_request" DROP CONSTRAINT "FK_episode_request_season"`
    );
    await queryRunner.query(`DROP INDEX "IDX_episode_request_season"`);
    await queryRunner.query(`DROP TABLE "episode_request"`);
  }
}
```

- [ ] **Step 4: Verify the SQLite migration runs on a scratch DB**

```bash
# Use a throwaway config dir so the real DB is untouched.
CONFIG_DIRECTORY=$(mktemp -d) pnpm migration:run
```
Expected: log shows `AddEpisodeRequest<TIMESTAMP>` executed with no errors. (This runs the full migration chain against a fresh SQLite DB, ending with ours.)

- [ ] **Step 5: Commit**

```bash
git add server/migration/sqlite server/migration/postgres
git commit -m "feat(episodes): add episode_request table migrations (sqlite + postgres)"
```

---

## Task 7: Frontend — episode checkboxes in the request modal

**Files:**
- Modify: `src/components/RequestModal/TvRequestModal.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/tv/:id/season/:seasonNumber` (returns `{ episodes: { episodeNumber: number; name: string; ... }[] }`, TMDB episode numbers); the request `POST` payload now accepts `episodes: { seasonNumber: number; episodes: number[] }[]`.
- Produces: user-selected per-episode requests sent in the payload; whole-season toggles unchanged.

> No frontend test harness exists. Verify with `pnpm typecheck:client`, `pnpm lint`, `pnpm build:next`, and the manual E2E in Task 8.

- [ ] **Step 1: Add selection + expansion state**

Near the existing `const [selectedSeasons, setSelectedSeasons] = useState<number[]>([]);`, add:

```tsx
  const [expandedSeasons, setExpandedSeasons] = useState<number[]>([]);
  const [selectedEpisodes, setSelectedEpisodes] = useState<
    Record<number, number[]>
  >({});
```

- [ ] **Step 2: Add a per-season episode fetcher + toggle helpers**

Add a small child component so a season's episodes are fetched lazily only when expanded (conditional SWR key). Place it in the same file (or a sibling `SeasonEpisodes.tsx` if the file is already large):

```tsx
const SeasonEpisodes: React.FC<{
  tmdbId: number;
  seasonNumber: number;
  selected: number[];
  onToggle: (episodeNumber: number) => void;
}> = ({ tmdbId, seasonNumber, selected, onToggle }) => {
  const { data } = useSWR<{ episodes: { episodeNumber: number; name: string }[] }>(
    `/api/v1/tv/${tmdbId}/season/${seasonNumber}`
  );
  if (!data) {
    return <div className="p-2 text-sm text-gray-400">Loading episodes…</div>;
  }
  return (
    <div className="flex flex-col gap-1 p-2">
      {data.episodes
        .filter((ep) => ep.episodeNumber !== 0)
        .map((ep) => (
          <label key={ep.episodeNumber} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(ep.episodeNumber)}
              onChange={() => onToggle(ep.episodeNumber)}
            />
            <span>
              {ep.episodeNumber}. {ep.name}
            </span>
          </label>
        ))}
    </div>
  );
};
```

And the toggle handler inside the modal component:

```tsx
  const toggleEpisode = (seasonNumber: number, episodeNumber: number) => {
    setSelectedEpisodes((prev) => {
      const current = prev[seasonNumber] ?? [];
      const next = current.includes(episodeNumber)
        ? current.filter((n) => n !== episodeNumber)
        : [...current, episodeNumber];
      return { ...prev, [seasonNumber]: next };
    });
  };
```

- [ ] **Step 3: Render the expander in each season row**

In the season `.map(...)` row (the `<tr>`), add an expand toggle (e.g. a chevron button in the first/last cell) that flips membership in `expandedSeasons`, and after the `<tr>`, conditionally render an episodes row:

```tsx
  {expandedSeasons.includes(season.seasonNumber) && (
    <tr>
      <td colSpan={4}>
        <SeasonEpisodes
          tmdbId={tmdbId ?? (data?.id as number)}
          seasonNumber={season.seasonNumber}
          selected={selectedEpisodes[season.seasonNumber] ?? []}
          onToggle={(ep) => toggleEpisode(season.seasonNumber, ep)}
        />
      </td>
    </tr>
  )}
```

(Use the `tmdbId` variable the modal already has for its `useSWR<TvDetails>` key.)

- [ ] **Step 4: Include `episodes` in the request payload**

In `sendRequest` (the `axios.post('/api/v1/request', {...})` call), add an `episodes` field built from `selectedEpisodes`, and ensure whole-season `seasons` excludes any season that has individual episodes selected:

```tsx
    const episodeSelections = Object.entries(selectedEpisodes)
      .map(([seasonNumber, episodes]) => ({
        seasonNumber: Number(seasonNumber),
        episodes,
      }))
      .filter((sel) => sel.episodes.length > 0);

    const partialSeasonNumbers = episodeSelections.map((s) => s.seasonNumber);

    // ...in the axios.post body:
    //   seasons: <existing expression>.filter((s) => !partialSeasonNumbers.includes(s)),
    //   episodes: episodeSelections,
```

Apply the same `.filter((s) => !partialSeasonNumbers.includes(s))` to the existing `seasons` expression, and add `episodes: episodeSelections` to the body.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck:client && pnpm lint && pnpm build:next`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/RequestModal/TvRequestModal.tsx
git commit -m "feat(episodes): per-season episode checkboxes in the TV request modal"
```

---

## Task 8: End-to-end verification on the live instance

**Files:** none (operational). This task produces the evidence that the feature works.

**Prerequisite:** the operator has completed the **upgrade** step (official Seerr 3.x image, automatic migration) and verified the instance works as before, per the design spec §11. Only then deploy the patched image.

- [ ] **Step 1: Build the patched image**

```bash
docker build -t seerr:single-episode .
```

- [ ] **Step 2: Deploy behind the existing compose**

Point the Seerr service `image:` at `seerr:single-episode`, ensure `init: true` and config-dir ownership by UID 1000 (spec §9.4), then `docker compose up -d`.

- [ ] **Step 3: Exercise the feature**

In the web UI: open a TV title → Request → expand a season → tick exactly **one** episode → submit and approve.

- [ ] **Step 4: Confirm in Sonarr (the real evidence)**

In Sonarr, open the series → confirm ONLY the selected episode is monitored and that a single grab/queue entry appears for it — not the whole season. Record the result (screenshot or Sonarr activity line). If more than one episode was grabbed, STOP and debug before calling this done.

- [ ] **Step 5: Rollback rehearsal**

Verify rollback works: point `image:` back at the official Seerr tag, `docker compose up -d`, confirm the instance still loads (episode requests already made remain as season/episode rows; no crash).

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3 components → Tasks 1–7; §4 data model → Task 2 + Task 6; §5 API → Task 3; §6 backend flow → Tasks 4–5; §7 frontend → Task 7; §8 availability (unchanged) → intentionally no task; §9 risks → Task 4 (Sonarr timing retry), Task 5 (existing-series path via `fullSeasonNumbers`), Task 8 (compose prereqs); §10 testing → Tasks 1–3 (unit/API), Task 8 (manual E2E), with the honest note that no frontend test harness exists; §11 rollout → Task 8; §12 growth-to-B → the `EpisodeRequest` entity in Task 2 is the foundation.
- **Placeholder scan:** the only deferred spots are the two "use the same `status` expression as the surrounding code" notes in Task 3 Step 4 — deliberate, because the auto-approval status must be copied verbatim from the live code, not reinvented. `<TIMESTAMP>` markers in Task 6 are filled by the migration generator.
- **Type consistency:** `EpisodeTarget`, `splitSeasonRequests`, `resolveEpisodeIds`, `searchEpisodes`, `monitorAndSearchEpisodes` names/signatures are consistent across Tasks 1, 4, 5. `episodes` body shape (`{ seasonNumber, episodes: number[] }[]`) is identical in Task 3 (API), Task 7 (frontend payload), and the `splitSeasonRequests` input.
