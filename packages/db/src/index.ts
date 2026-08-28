export * as schema from './schema.ts'
export { connect, close, type ConnectOptions, type Db } from './client.ts'
export { migrate, type MigrateOptions } from './migrate.ts'

export {
  MAX_ATTEMPTS,
  claimJob,
  enqueue,
  enqueueMany,
  failJob,
  finishJob,
  queueDepth,
  reclaimStaleJobs,
  type EnqueueInput,
  type JobRow,
} from './queue.ts'

export {
  contentHash,
  markConsumed,
  readChangeEvents,
  sweepAbsent,
  writeRecords,
  type ChangeEventRow,
  type RecordInput,
  type WriteResult,
} from './records.ts'

export {
  createSource,
  dueSources,
  getSource,
  getSourceByKey,
  setSourceState,
  type SourceRow,
  type SourceState,
} from './sources.ts'

export {
  activeAdapter,
  canaryAdapter,
  getAdapter,
  insertAdapter,
  nextVersion,
  promoteToActive,
  promoteToCanary,
  rejectAdapter,
  rollback,
  type AdapterRow,
  type AdapterStatus,
  type InsertAdapterInput,
} from './adapters.ts'

export { recentRuns, recordRun, runsForAdapter, type RecordRunInput } from './runs.ts'

export {
  captureFixture,
  fixturesByIds,
  fixturesForSource,
  setExpected,
  type CaptureFixtureInput,
} from './fixtures.ts'

export {
  claimCompileRun,
  failCompileRun,
  finishCompileRun,
  logCompileStep,
  queueCompileRun,
  failedRepairCount,
  type CompileRunRow,
  type QueueCompileRunInput,
} from './compile.ts'
