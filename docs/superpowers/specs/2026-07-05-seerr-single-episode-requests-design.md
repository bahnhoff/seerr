# Design: Single-Episode Requests in Seerr

- **Date:** 2026-07-05
- **Status:** Approved (design), pending implementation plan
- **Base:** Seerr `v3.3.0`, branch `feature/single-episode-requests`
- **Related upstream issue:** [#264 — Single episode requests](https://github.com/seerr-team/seerr/issues/264) (open since 2022, canonical, many duplicates)

## 1. Context & Problem

Seerr (the unified successor of Overseerr + Jellyseerr) lets users request TV
media only at **season** granularity. Requesting a single episode forces a
full-season download. The actual downloader, **Sonarr**, already supports
episode-level monitoring and search, so the capability exists downstream — it is
simply not exposed through Seerr's request flow.

The operator runs Jellyfin + Jellyseerr **2.7.3** on `192.168.1.37:5055`
(Docker/Compose, SSH access available). Jellyseerr 2.x is the frozen pre-merge
line; the maintained codebase is Seerr 3.x.

## 2. Goal & Non-Goals

**Goal (v1):** In the TV request modal, expand a season and tick individual
episodes via checkboxes. On submit, Sonarr monitors and searches **only** the
selected episodes. The existing season-level request path stays untouched.

**v1 explicitly does NOT do (deferred to "v2 / B"):**
- Per-episode availability reconciliation (Seerr keeps its current per-season
  "X/Y episodes available" display).
- Per-episode notifications (notifications stay at season granularity).
- Per-episode approval semantics (approval stays at season-request level).

**Chosen approach:** "A now, B later" — ship a pragmatic v1 that drives Sonarr
correctly, but model the data properly (a real `EpisodeRequest` entity) so it can
grow into the fully-integrated, upstream-PR-able version without a rewrite.

## 3. Architecture — Components Touched

Seerr is a monorepo: Next.js frontend (`src/`) + Node/Express/TypeORM backend
(`server/`). Four touch points, all confirmed to exist in `v3.3.0`:

| Layer | File | Change |
|---|---|---|
| Data model | `server/entity/SeasonRequest.ts` (44 lines) | Add `OneToMany` → new `EpisodeRequest` entity |
| Data model | `server/entity/EpisodeRequest.ts` (**new**) | `{ id, episodeNumber, status, seasonRequest FK }` |
| Migration | `server/migration/**` (**new**) | Create `episode_request` table only — no change to existing rows |
| API | `server/routes/request.ts` (+ `request.test.ts`) | Accept optional per-season `episodes: number[]`; backward-compatible |
| Backend sync | `server/subscriber/MediaRequestSubscriber.ts` `sendToSonarr()` (lines ~477–760; `AddSeriesOptions` built ~703–716) | When a season request carries specific episodes, drive episode-level monitor + search |
| Sonarr client | `server/api/servarr/sonarr.ts` | **Reuse** existing `getEpisodes()` / `monitorEpisodes()`; add `searchEpisodes(episodeIds)` (`EpisodeSearch` command) if not already present |
| Frontend | `src/components/RequestModal/TvRequestModal.tsx` | Per-season expander with episode checkboxes; lazy-fetch season detail |

**Key de-risking finding:** `sonarr.ts` already contains an `EpisodeResult`
interface, `getEpisodes(seriesId)`, and `monitorEpisodes(episodeIds)`, and
`addSeries()` already iterates episodes to re-monitor specific ones per requested
season (lines ~220–247 in v3.3.0). We extend this existing machinery rather than
building the Sonarr episode integration from scratch.

## 4. Data Model & Migration

New entity, child of `SeasonRequest` (mirrors how `SeasonRequest` is a child of
`MediaRequest`):

```
EpisodeRequest {
  id: PK
  episodeNumber: int
  status: MediaRequestStatus   // reuse existing enum
  seasonRequest: ManyToOne -> SeasonRequest
  createdAt / updatedAt
}
SeasonRequest {
  ...existing...
  episodes: OneToMany -> EpisodeRequest   // NEW; empty = whole season (today's behavior)
}
```

**Semantics:** An empty `episodes` collection on a `SeasonRequest` means "the
whole season" — identical to current behavior. A non-empty collection means "only
these episodes." This keeps the change fully backward-compatible.

**Migration:** Adds the `episode_request` table only. No transformation of
existing data → low risk, trivially reversible.

## 5. API Contract

`POST /api/v1/request` currently accepts seasons as `number[]` or `'all'`. Extend
the TV shape to optionally carry episodes per season, e.g.:

```jsonc
{
  "mediaType": "tv",
  "mediaId": 1399,
  "seasons": [ { "seasonNumber": 1, "episodes": [5] } ]   // episodes optional
}
```

- Omitting `episodes` (or the current `number[]` form) → whole-season request,
  unchanged.
- Validation: episode numbers must exist in that season (checked against
  TMDB/season metadata already available to Seerr).

## 6. Backend Flow (`sendToSonarr`)

```
User ticks S01E05
  -> POST /api/v1/request { seasons:[{seasonNumber:1, episodes:[5]}] }
  -> persist MediaRequest + SeasonRequest(1) + EpisodeRequest(5)
  -> approval flow (unchanged, season-request level)
  -> sendToSonarr():
       1. addSeries / updateSeries: requested season NOT monitored season-wide,
          searchForMissingEpisodes = false for it
       2. getEpisodes(seriesId)  -> resolve episodeId(s) for the selected numbers
       3. monitorEpisodes(selectedEpisodeIds, monitored=true)   [existing method]
       4. searchEpisodes(selectedEpisodeIds)  -> EpisodeSearch command
  -> Sonarr grabs ONLY the selected episodes.
```

## 7. Frontend (`TvRequestModal.tsx`)

- Each season row gets an expander. On expand, lazy-fetch season detail
  (`/api/v1/tv/{id}/season/{n}`) to list episodes.
- Per-episode checkboxes. Ticking the season checkbox = select all episodes
  (equivalent to today's season request). Mixed selection = episode request.
- Submit builds the per-season `episodes` arrays described in §5.

## 8. Availability / Approval / Notifications (v1)

Unchanged. Seerr already computes and displays per-season available-episode
counts from the media-server scan; that display remains and will correctly show
partial availability. Request status follows the season request. Accepting this
imperfect state tracking is the explicit v1 trade-off; §11 describes how B closes
the gap.

## 9. Risks & Mitigations

1. **Sonarr episode-metadata timing.** After `addSeries`, Sonarr refreshes the
   series asynchronously; episodes may not be immediately queryable via
   `getEpisodes`. → Poll/retry with a short backoff before monitoring/searching.
   (The existing re-monitor code path already reads episodes after add, so the
   pattern and its timing behavior are observable in the current code.)
2. **Series already in Sonarr.** The update path must not clobber a season that
   was previously requested/monitored season-wide. → Rule: episode requests apply
   only to seasons not already fully requested; otherwise fall back to a normal
   season request.
3. **Upstream rebase cost.** Every Seerr update requires re-applying the patch.
   → Keep the patch small and localized to the files in §3; track upstream and
   rebase the feature branch.
4. **Upgrade prerequisites** (Jellyseerr 2.7.3 → Seerr 3.x, from the official
   [migration guide](https://docs.seerr.dev/migration-guide/)): container needs an
   init process (`init: true` in compose) to avoid zombie processes; container
   runs non-root as `node` (UID 1000), so the config dir must be chown-able to
   1000. Postgres mount-point change applies only if using Postgres (default is
   SQLite → likely N/A).

## 10. Testing Strategy

- **Backend unit:** `sendToSonarr()` builds the correct payload and calls
  `monitorEpisodes` / `searchEpisodes` with the right episode IDs (Sonarr mocked).
- **API test** (`request.test.ts`): extended payload accepted; existing
  season/`'all'` payloads behave identically (regression guard).
- **Migration test:** table created; reverse migration clean.
- **Frontend component test:** episode checkboxes render, select, and serialize
  into the request payload.
- **Manual E2E on the live instance:** request exactly one episode → verify in
  Sonarr that only that episode is grabbed. Evidence required before "done."

## 11. Rollout (two separate, individually verified steps)

1. **Upgrade.** Pull the official Seerr 3.x image → automatic DB migration runs on
   first start → **verify** everything works as before (login, existing requests,
   Sonarr link). Apply the §9.4 compose prerequisites.
2. **Patch.** Build the fork's custom Docker image from
   `feature/single-episode-requests` → swap the image → **verify** single-episode
   request end-to-end.
   **Rollback:** point the image back at the official tag.

## 12. Growth Path to "B" (upstream-PR-able)

The `EpisodeRequest` entity introduced in v1 is the foundation for B. B adds:
per-episode availability reconciliation (from Sonarr webhooks / media scan),
per-episode request status transitions, and per-episode notifications — then the
feature can be submitted as a PR closing #264. No data-model rewrite required
because v1 already models episodes as first-class rows.

## 13. Open Questions for the Planning Phase

- Exact location/shape of `sendToSonarr` season-monitoring construction in
  `MediaRequest.ts` (v3.3.0 line-level).
- Whether an `EpisodeSearch` helper already exists in `sonarr.ts` or must be added.
- Frontend: does `TvRequestModal` already fetch season detail anywhere reusable,
  or is a new lazy fetch needed?
- Quota accounting: should an episode request count differently from a season
  request against user quotas? (v1 default: count as one request.)
