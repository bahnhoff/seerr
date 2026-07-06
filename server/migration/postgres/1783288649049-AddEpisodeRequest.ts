import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeRequest1783288649049 implements MigrationInterface {
  name = 'AddEpisodeRequest1783288649049';

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
