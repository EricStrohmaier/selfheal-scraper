export type {
  Adapter,
  ExtractDocument,
  ExtractInput,
  FetchPlan,
  FixtureBody,
} from './contract.ts'

export {
  MAX_LINES,
  validateAdapterSource,
  type ValidateOptions,
  type ValidationResult,
  type ValidationRule,
  type Violation,
} from './validator.ts'

export {
  DEFAULT_TIMEOUT_MS,
  SCRIPT_CACHE_MAX,
  SandboxError,
  clearScriptCache,
  runAdapter,
  scriptCacheSize,
  type AdapterEntryPoint,
  type SandboxFailureKind,
  type SandboxOptions,
} from './sandbox.ts'

export {
  TranspileError,
  sha256,
  stripTypes,
  transpile,
  type Transpiled,
} from './transpile.ts'

export { loadFixtures, type FixtureManifestEntry } from './fixtures.ts'

export {
  MIN_FIXTURES,
  runGate,
  type FixtureOutcome,
  type GateFailure,
  type GateFailureRule,
  type GateFixture,
  type GateFixtureReport,
  type GateInput,
  type GateResult,
} from './gate.ts'
