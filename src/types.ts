import type {Address, Cell, Transaction as CoreTransaction, OutAction} from "@ton/core"

export interface RetraceNetworkConfig {
  /**
   * True for testnet-compatible address formatting.
   */
  testnet?: boolean
  /**
   * Toncenter-compatible API v2 base URL, for example, https://toncenter.com/api/v2.
   */
  v2BaseUrl: string
  /**
   * Toncenter-compatible API v3 base URL, for example, https://toncenter.com/api/v3.
   */
  v3BaseUrl: string
  /**
   * Optional Toncenter API key for both v2 and v3 requests.
   */
  toncenterApiKey?: string
}

export interface RetraceOptions {
  /**
   * Additional TVM libraries as `[hash, code]` pairs. Use this for libraries
   * that are not available from the configured Toncenter-compatible endpoint.
   */
  additionalLibs?: [bigint, Cell][]
  /**
   * Optional Tolk compiler source map. Provide this to include source-level
   * steps in the retrace result.
   */
  sourceMap?: TolkSourceMapData
}

export interface EmulateRawMessageOptions extends RetraceOptions {
  /**
   * Masterchain block seqno whose resulting account state and config should be used.
   * When omitted, the latest masterchain block is used.
   */
  mcSeqno?: number
  /**
   * Override transaction unix timestamp. Defaults to the selected block generation time.
   */
  now?: number
  /**
   * Override transaction logical time. Defaults to selected block end_lt + 1.
   */
  lt?: bigint
  /**
   * Ask TVM to ignore CHKSIG/CHKSIGNU signature checks during emulation.
   */
  ignoreChksig?: boolean
  /**
   * Maximum number of transactions to emulate from the message cascade. Defaults to 128.
   */
  maxTransactions?: number
  /**
   * Optional starting account states keyed by account address.
   */
  accountStateOverrides?: Record<string, EmulateRawMessageAccountStateOverride>
}

export interface EmulateRawMessageAccountStateOverride {
  /** Full ShardAccount BoC encoded as hex or base64. */
  shardAccountBoc?: string
  /** Override account balance in nanotons. */
  balance?: bigint | string
  /** Override account code/data state. */
  state?: EmulateRawMessageAccountStateDataOverride
  /**
   * Override ShardAccount last transaction lt. AccountStorage lastTransLt defaults
   * to zero for LT zero, and to this LT plus one otherwise.
   */
  lastTransactionLt?: bigint | string
  /** Override ShardAccount last transaction hash. */
  lastTransactionHash?: bigint | string
  /** Override AccountStorage lastTransLt separately from ShardAccount lt. */
  storageLastTransactionLt?: bigint | string
}

export type EmulateRawMessageAccountStateDataOverride =
  | EmulateRawMessageAccountActiveStateOverride
  | EmulateRawMessageAccountUninitStateOverride
  | EmulateRawMessageAccountFrozenStateOverride

export interface EmulateRawMessageAccountActiveStateOverride {
  type: "active"
  /** Omit to preserve code, or use null to clear it. */
  codeBoc?: string | null
  /** Omit to preserve data, or use null to clear it. */
  dataBoc?: string | null
}

export interface EmulateRawMessageAccountUninitStateOverride {
  type: "uninit"
}

export interface EmulateRawMessageAccountFrozenStateOverride {
  type: "frozen"
  /** Preserve the current frozen hash when possible, otherwise default to zero. */
  stateHash?: bigint | string
}

/**
 * Tolk compiler output required to map TVM execution back to source locations.
 */
export interface TolkSourceMapData {
  /**
   * Base64-encoded code BoC produced by the same compilation as the source map.
   * Its hash must match the transaction account code hash.
   */
  codeBoc64: string
  /**
   * Compiler `symbolTypesJson` payload used to decode source locations and
   * local variable types.
   */
  symbolTypesJson: unknown
  /**
   * Compiler `debugMarksJson` payload with source ranges for debug mark ids.
   */
  debugMarksJson: readonly unknown[]
  /**
   * Compiler `debugMarksBase64` payload with debug mark positions in bytecode.
   */
  debugMarksBase64: string
}

/**
 * Source trace request accepted by `buildSourceTrace`.
 */
export interface BuildSourceTraceRequest {
  /**
   * VM logs from the emulated transaction.
   */
  vmLogs: string
  /**
   * Expected account code hash in hex. Used to verify `compiled.codeBoc64`
   * belongs to the executed code.
   */
  codeHash: string
  /**
   * Optional runtime context that is not present in raw VM logs but is useful
   * for source-level variables.
   */
  context?: SourceTraceContext
  /**
   * Compiled Tolk source-map payload.
   */
  compiled: TolkSourceMapData
}

export interface SourceTraceContext {
  /**
   * Incoming message context for the traced transaction.
   */
  inMsg?: SourceTraceInMessageContext
}

export interface SourceTraceInMessageContext {
  /**
   * Sender address string injected as `in.senderAddress` when tracing
   * `onInternalMessage`.
   */
  senderAddress?: string
}

export interface SourceTraceResponse {
  codeHash: string
  files: readonly SourceTraceFileInfo[]
  steps: readonly SourceTraceStep[]
  truncated: boolean
}

export interface SourceTraceFileInfo {
  path: string
}

export interface SourceTraceStep {
  index: number
  location: SourceTraceLocation
  instruction: string | null
  vmPosition: SourceTraceVmPosition | null
  locals: readonly SourceTraceVariable[]
  stack: readonly string[]
  callStack: readonly SourceTraceFrame[]
  exception: SourceTraceException | null
}

export interface SourceTraceLocation {
  file: string
  line: number
  column: number
  endLine: number
  endColumn: number
}

export interface SourceTraceVmPosition {
  cellHash: string
  offset: number
}

export interface SourceTraceFrame {
  functionName: string
  location: SourceTraceLocation | null
  isInlined: boolean
  isBuiltin: boolean
}

export interface SourceTraceVariable {
  name: string
  value: string
  type: string | null
  children: readonly SourceTraceVariable[]
}

export interface SourceTraceException {
  errno: string
  symbolicName: string | null
  isUncaught: boolean
}

// TonCenter v3 API response for get transactions
export interface TransactionData {
  transactions: Transaction[]
  address_book: Record<string, AddressBookEntry>
}

// TonCenter v3 API response for get traces
export interface TraceData {
  traces: Trace[]
  address_book: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface Trace {
  trace_id: string
  external_hash?: string | null
  mc_seqno_start: string
  mc_seqno_end: string
  start_lt: string
  start_utime: number
  end_lt: string
  end_utime: number
  is_incomplete: boolean
  trace: TraceNode
  transactions: Record<string, Transaction>
  /**
   * Canonical transaction processing order returned by Toncenter. Compatible
   * endpoints may omit it, in which case retrace uses logical time and the
   * trace tree as fallbacks.
   */
  transactions_order?: readonly string[]
  trace_info: {
    transactions: number
    messages: number
    pending_messages: number
    trace_state: string
    classification_state: string
  }
}

export interface TraceNode {
  tx_hash: string
  in_msg_hash?: string
  in_msg?: InMessage | null
  transaction?: Transaction
  children?: readonly TraceNode[]
}

interface ToncenterMessage {
  hash: string
  source: string | null
  destination: string | null
  value: string
  value_extra_currencies: Record<string, unknown>
  fwd_fee: string
  ihr_fee: string
  created_lt: string
  created_at: string | null
  opcode: string | number | null
  ihr_disabled: boolean
  bounce: boolean
  bounced: boolean
  import_fee: string | null
  message_content: {
    hash: string
    body: string
    decoded: Record<string, unknown> | null
  }
  init_state: {
    hash: string
    body: string
  } | null
}

export type OutMessage = ToncenterMessage

export interface Transaction {
  account: string
  hash: string
  lt: string
  now: number
  mc_block_seqno: number
  trace_id: string
  prev_trans_hash: string
  prev_trans_lt: string
  orig_status: string
  end_status: string
  total_fees: string
  total_fees_extra_currencies: Record<string, unknown>
  description?: Description
  block_ref: BlockRef
  in_msg?: InMessage | null
  out_msgs: OutMessage[]
  account_state_before?: AccountState | null
  account_state_after?: AccountState | null
  emulated: boolean
}

export interface AddressBookEntry {
  user_friendly: string
  domain: string | null
}

export interface Description {
  type: string
  aborted: boolean
  destroyed?: boolean
  credit_first?: boolean
  is_tock?: boolean
  storage_ph?: {
    storage_fees_collected?: string
    storage_fees_due?: string
    status_change?: string
  }
  credit_ph?: {
    credit: string
    credit_extra_currencies?: Record<string, string>
    due_fees_collected?: string
  }
  compute_ph?: {
    skipped: boolean
    reason?: string
    success: boolean
    msg_state_used?: boolean
    account_activated?: boolean
    gas_fees?: string
    gas_used?: string
    gas_limit?: string
    gas_credit?: string
    mode?: number
    exit_code: number
    exit_arg?: number
    vm_steps?: number
    vm_init_state_hash?: string
    vm_final_state_hash?: string
  }
  action?: {
    success: boolean
    valid?: boolean
    no_funds?: boolean
    status_change?: string
    result_code: number
    result_arg?: number
    tot_actions?: number
    spec_actions?: number
    skipped_actions?: number
    msgs_created?: number
    total_fwd_fees?: string
    total_action_fees?: string
    action_list_hash?: string
    tot_msg_size?: {
      cells?: string
      bits?: string
    }
  }
  bounce?: {
    type: string
    msg_size?: {
      cells: string
      bits: string
    }
    req_fwd_fees?: string
    msg_fees?: string
    fwd_fees?: string
  }
}

export interface BlockRef {
  workchain: number
  shard: string
  seqno: number
}

export type InMessage = ToncenterMessage

export interface AccountState {
  hash: string
  balance: string
  extra_currencies: Record<string, unknown>
  account_status: string
  frozen_hash: string | null
  data_hash: string
  code_hash: string
}

/** A message synthesized locally by {@link EmulateRawMessageResult}. */
export interface EmulatedMessage {
  hash: string
  source: string | null
  destination: string | null
  value: string
  value_extra_currencies: Record<string, unknown>
  fwd_fee: string
  ihr_fee: string
  created_lt: string
  created_at: string | null
  opcode: string | number | null
  ihr_disabled: boolean
  bounce: boolean
  bounced: boolean
  import_fee: string | null
  message_content: {
    hash: string
    body: string
    decoded: Record<string, unknown> | null
  }
  init_state: {
    hash: string
    body: string
  } | null
}

/** Account state synthesized from the exact ShardAccount used by local emulation. */
export interface EmulatedAccountState {
  hash: string
  balance: string | null
  code_boc: string | null
  extra_currencies: Record<string, string>
  account_status: string
  data_boc: string | null
  frozen_hash: string | null
  data_hash: string | null
  code_hash: string | null
}

export interface EmulatedTransaction
  extends Omit<
    Transaction,
    "description" | "in_msg" | "out_msgs" | "account_state_before" | "account_state_after"
  > {
  description: EmulatedDescription
  in_msg: EmulatedMessage | null
  out_msgs: EmulatedMessage[]
  account_state_before: EmulatedAccountState
  account_state_after: EmulatedAccountState
  child_transactions: readonly string[]
}

/** Toncenter-shaped description whose skipped compute phase remains intentionally sparse. */
export interface EmulatedDescription extends Omit<Description, "compute_ph"> {
  compute_ph?: EmulatedComputePhase
}

export interface EmulatedComputePhase
  extends Omit<NonNullable<Description["compute_ph"]>, "success" | "exit_code"> {
  success?: boolean
  exit_code?: number
}

export interface EmulatedTraceNode {
  tx_hash: string
  in_msg_hash?: string
  in_msg?: EmulatedMessage | null
  transaction?: EmulatedTransaction
  children?: readonly EmulatedTraceNode[]
}

export interface EmulatedTrace
  extends Omit<Trace, "trace" | "transactions" | "transactions_order"> {
  trace: EmulatedTraceNode
  transactions: Record<string, EmulatedTransaction>
  transactions_order: readonly string[]
}

// Raw transaction BoC paired with the shard block that contains it.
export interface RawTransaction {
  block: {
    workchain: number
    seqno: number
    shard: string
    rootHash: string
    fileHash: string
  }
  tx: CoreTransaction
}

// toncenter v3 blocks response
export interface BlocksResponse {
  blocks: Block[]
}

export interface Block {
  after_merge: boolean
  after_split: boolean
  before_split: boolean
  created_by: string
  end_lt: string
  file_hash: string
  flags: number
  gen_catchain_seqno: number
  gen_utime: string
  global_id: number
  key_block: boolean
  master_ref_seqno: number
  masterchain_block_ref: BlockRef
  min_ref_mc_seqno: number
  prev_blocks: BlockRef[]
  prev_key_block_seqno: number
  rand_seed: string
  root_hash: string
  seqno: number
  shard: string
  start_lt: string
  tx_count: number
  validator_list_hash_short: number
  version: number
  vert_seqno: number
  vert_seqno_incr: boolean
  want_merge: boolean
  want_split: boolean
  workchain: number
}

export type ComputeInfo =
  | "skipped"
  | {
      /**
       * If the phase is successful
       */
      success: boolean
      /**
       * Exit code of this phase
       */
      exitCode: number
      /**
       * Count of steps that VM executes until the end
       */
      vmSteps: number
      /**
       * Gas used for this phase
       */
      gasUsed: bigint
      /**
       * Gas fees for this phase
       */
      gasFees: bigint
    }

export interface TraceInMessage {
  /**
   * Sender of in-message
   *
   * Undefined if the in-message is an external message
   */
  sender: Address | undefined
  /**
   * Address of contract that received in-message.
   */
  contract: Address
  /**
   * Number of toncoin for in-message
   *
   * Undefined if the in-message is an external message
   */
  amount: bigint | undefined
  /**
   * Opcode of the in-message
   */
  opcode: number | undefined
}

export interface TraceAccountState {
  /**
   * Serialized ShardAccount before the emulated transaction, base64 BoC.
   */
  shardAccountBefore: string
  /**
   * Serialized ShardAccount after the emulated transaction, base64 BoC.
   */
  shardAccountAfter: string
}

export interface TraceEmulatedTx {
  /**
   * Raw BoC of the emulated transaction in hex format
   */
  raw: string
  /**
   * Unix timestamp of the emulated transaction
   */
  utime: number
  /**
   * Logical time of the emulated transaction
   */
  lt: bigint
  /**
   * Information about compute-phase for emulated transaction
   */
  computeInfo: ComputeInfo
  /**
   * Logs of emulated transaction
   */
  executorLogs: string
  /**
   * Represent parsed content of register c5 for emulated transaction
   */
  actions: OutAction[]
  /**
   * Represent raw content of register c5 as Cell for emulated transaction
   *
   * Undefined if there was no log entry for the c5 contents
   */
  c5: Cell | undefined
  /**
   * Emulated transaction execution logs from Ton Virtual Machine
   */
  vmLogs: string
}

export interface TraceMoneyResult {
  /**
   * Account balance before transaction
   */
  balanceBefore: bigint
  /**
   * Sum of all out internal messages values
   */
  sentTotal: bigint
  /**
   * The total fees collected during the transaction execution,
   * including TON coin and potentially some extra-currencies.
   */
  totalFees: bigint
  /**
   * Account balance after transaction
   */
  balanceAfter: bigint
}

// TxTracer result
export interface TraceResult {
  /**
   * Sets to true if the emulated transaction hash is equal to one from the real blockchain
   */
  stateUpdateHashOk: boolean
  /**
   * Code of an account before transaction. If code is just an exotic cell,
   * this field will contain actual library code, see {@link originalCodeCell}
   * if you need original code cell.
   */
  codeCell: Cell | undefined
  /**
   * Code of an account before transaction
   */
  originalCodeCell: Cell | undefined
  /**
   * Information about in-message
   */
  inMsg: TraceInMessage
  /**
   * Serialized account state before and after emulation.
   */
  account: TraceAccountState
  /**
   * Information about money-related things
   */
  money: TraceMoneyResult
  /**
   * Information about emulated transaction
   */
  emulatedTx: TraceEmulatedTx
  /**
   * Source-level Tolk trace, present only when retrace is called with `sourceMap`.
   */
  sourceTrace?: SourceTraceResponse
  emulatorVersion: {
    commitHash: string
    commitDate: string
  }
}

/**
 * Result of replaying a complete message trace with `retraceTrace`.
 */
export interface TraceReplayResult {
  /**
   * Normalized lowercase hex hash of the trace root, without a `0x` prefix.
   * It can differ from the input hash when a child transaction was requested.
   */
  rootTxHash: string
  /**
   * Per-transaction replay results keyed by normalized lowercase hex hash.
   * Entries are populated in replay order.
   */
  transactions: Record<string, TraceResult>
  /**
   * True only when every transaction produced the same state update as its
   * on-chain counterpart. Replayed state changes are not authoritative when false.
   */
  stateUpdateHashOk: boolean
  /**
   * TON Sandbox executor version used for every transaction in this replay.
   */
  emulatorVersion: {
    /** Executor source commit hash. */
    commitHash: string
    /** Executor source commit date. */
    commitDate: string
  }
}

/** Result of emulating a raw inbound message and every internal message it produces. */
export interface EmulateRawMessageResult {
  rootTxHash: string
  transactions: Record<string, TraceResult>
  trace: EmulatedTrace
  /**
   * Always true: raw-message emulation has no on-chain state update to compare against.
   * Individual account snapshots are available in each transaction result.
   */
  stateUpdateHashOk: true
  emulatorVersion: {
    commitHash: string
    commitDate: string
  }
}
