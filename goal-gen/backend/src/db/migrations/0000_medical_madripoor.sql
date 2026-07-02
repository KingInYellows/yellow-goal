CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."completion_policy" AS ENUM('verify-only', 'verify+signoff', 'operator-defined');--> statement-breakpoint
CREATE TYPE "public"."executor_kind" AS ENUM('claude-code', 'codex', 'antigravity', 'mcp', 'shell');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'failed', 'cancelled', 'budget-exhausted');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'active', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"step_id" text NOT NULL,
	"action_id" text NOT NULL,
	"attempt" integer,
	"executor" "executor_kind" NOT NULL,
	"status" "agent_run_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"stdout" text,
	"stderr" text,
	"exit_code" integer,
	"diff_ref" text,
	"diff_content" text,
	"tokens" integer,
	"cost_usd" numeric(12, 6)
);
--> statement-breakpoint
CREATE TABLE "goal_specs" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_text" text NOT NULL,
	"goal_state" jsonb NOT NULL,
	"completion_policy" "completion_policy" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"action_id" text NOT NULL,
	"sequence_index" integer NOT NULL,
	"status" "step_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_spec_id" text NOT NULL,
	"replan_of" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"step_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"status" "run_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"accumulated_cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_step_id_plan_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."plan_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_goal_spec_id_goal_specs_id_fk" FOREIGN KEY ("goal_spec_id") REFERENCES "public"."goal_specs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_replan_of_plans_id_fk" FOREIGN KEY ("replan_of") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_step_id_plan_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."plan_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;