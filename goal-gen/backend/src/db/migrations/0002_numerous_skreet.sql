ALTER TABLE "run_events" ADD COLUMN "sequence" integer;--> statement-breakpoint
UPDATE "run_events" SET "sequence" = sub.rn - 1 FROM (SELECT "id", row_number() OVER (PARTITION BY "run_id" ORDER BY "id") AS rn FROM "run_events") sub WHERE "run_events"."id" = sub."id";--> statement-breakpoint
ALTER TABLE "run_events" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_id_sequence_idx" ON "run_events" USING btree ("run_id","sequence");