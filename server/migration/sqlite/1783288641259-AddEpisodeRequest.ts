import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeRequest1783288641259 implements MigrationInterface {
  name = 'AddEpisodeRequest1783288641259';

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
