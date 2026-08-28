/**
 * Drizzle definitions mirroring schema.sql plus migrations/.
 *
 * schema.sql stays the source of truth — it is what actually gets applied. These
 * definitions exist so table shapes are typed in one place instead of being restated
 * as row interfaces at every call site. Anything drizzle cannot express well (the
 * `FOR UPDATE SKIP LOCKED` claim, the upsert-plus-outbox CTE) is written as raw SQL,
 * because those queries *are* the design and hiding them behind a builder would make
 * them harder to review, not easier.
 */

import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const forge = pgSchema('forge')
export const runtime = pgSchema('runtime')

export const sourceState = forge.enum('source_state', [
  'new',
  'compiling',
  'active',
  'degraded',
  'repairing',
  'disabled',
])

export const adapterStatus = forge.enum('adapter_status', [
  'draft',
  'canary',
  'active',
  'retired',
  'rejected',
])

export const fetchTier = forge.enum('fetch_tier', ['http', 'browser'])
export const compileKind = forge.enum('compile_kind', ['compile', 'repair'])
export const compileState = forge.enum('compile_state', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'abandoned',
])
export const jobState = runtime.enum('job_state', ['queued', 'running', 'done', 'failed', 'dead'])

export const source = forge.table('source', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  intent: text('intent').notNull(),
  entryUrl: text('entry_url').notNull(),
  urlPattern: text('url_pattern'),
  /** Human-owned. No agent code path may write to this column. */
  outputSchema: jsonb('output_schema').notNull(),
  /** Human-owned, same rule. */
  requiredFields: text('required_fields').array().notNull().default([]),
  cadence: text('cadence').notNull().default('1 day'),
  state: sourceState('state').notNull().default('new'),
  fetchHints: jsonb('fetch_hints').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const adapter = forge.table(
  'adapter',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id').notNull(),
    version: integer('version').notNull(),
    status: adapterStatus('status').notNull().default('draft'),
    fetchPlan: jsonb('fetch_plan').notNull(),
    codeTs: text('code_ts').notNull(),
    codeJs: text('code_js').notNull(),
    codeHash: text('code_hash').notNull(),
    notes: text('notes'),
    compileRunId: uuid('compile_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('adapter_source_version').on(t.sourceId, t.version)],
)

export const fixture = forge.table(
  'fixture',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id').notNull(),
    url: text('url').notNull(),
    tier: fetchTier('tier').notNull(),
    statusCode: integer('status_code'),
    headers: jsonb('headers'),
    /** gzipped */
    body: text('body').notNull(),
    /** golden output, set once a human confirms it */
    expected: jsonb('expected'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('fixture_by_source').on(t.sourceId, t.capturedAt)],
)

export const compileRun = forge.table('compile_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull(),
  kind: compileKind('kind').notNull(),
  state: compileState('state').notNull().default('queued'),
  trigger: jsonb('trigger').notNull().default({}),
  input: jsonb('input').notNull().default({}),
  resultAdapterId: uuid('result_adapter_id'),
  model: text('model'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
  iterations: integer('iterations').notNull().default(0),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  lockedBy: text('locked_by'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const compileStep = forge.table('compile_step', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  compileRunId: uuid('compile_run_id').notNull(),
  n: integer('n').notNull(),
  tool: text('tool').notNull(),
  input: jsonb('input'),
  outputSummary: jsonb('output_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const job = runtime.table(
  'job',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sourceId: uuid('source_id').notNull(),
    url: text('url').notNull(),
    externalKey: text('external_key').notNull(),
    priority: integer('priority').notNull().default(100),
    state: jobState('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('job_source_url').on(t.sourceId, t.url)],
)

export const run = runtime.table(
  'run',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobId: bigint('job_id', { mode: 'number' }),
    sourceId: uuid('source_id').notNull(),
    adapterId: uuid('adapter_id').notNull(),
    adapterVersion: integer('adapter_version').notNull(),
    canary: boolean('canary').notNull().default(false),
    httpStatus: integer('http_status'),
    fetchMs: integer('fetch_ms'),
    parseMs: integer('parse_ms'),
    bytes: integer('bytes'),
    items: integer('items').notNull().default(0),
    validItems: integer('valid_items').notNull().default(0),
    fieldNulls: jsonb('field_nulls'),
    /** ok | schema_invalid | empty | fetch_error | exec_error | timeout | blocked */
    outcome: text('outcome').notNull(),
    error: text('error'),
    /** which tier actually served the bytes — migrations/001 */
    tierUsed: text('tier_used'),
    /** true when the http tier soft-failed and we climbed to the browser */
    escalated: boolean('escalated').notNull().default(false),
    /** false when the run stopped early; guards the absence sweep */
    complete: boolean('complete').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_health').on(t.sourceId, t.createdAt)],
)

export const record = runtime.table(
  'record',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sourceId: uuid('source_id').notNull(),
    externalKey: text('external_key').notNull(),
    payload: jsonb('payload').notNull(),
    contentHash: text('content_hash').notNull(),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
    lastRunId: bigint('last_run_id', { mode: 'number' }),
    /** migrations/001 — false once an absence sweep saw it disappear */
    isActive: boolean('is_active').notNull().default(true),
    goneAt: timestamp('gone_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('record_source_key').on(t.sourceId, t.externalKey)],
)

export const changeEvent = runtime.table('change_event', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  recordId: bigint('record_id', { mode: 'number' }).notNull(),
  sourceId: uuid('source_id').notNull(),
  /** insert | update | gone */
  kind: text('kind').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})
