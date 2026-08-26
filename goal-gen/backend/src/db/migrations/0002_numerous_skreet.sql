ALTER TABLE "run_events" ADD COLUMN "sequence" integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_id_sequence_idx" ON "run_events" USING btree ("run_id","sequence");