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
    additionalLibs?: [bigint, Cell][]
    /**
     * Optional source-level trace input. Provide this when the contract source
     * was compiled with Tolk debug marks, and you want to retrace steps mapped back
     * to source files.
     */
    sourceTrace?: RetraceSourceTraceOptions
}

/**
 * Source-level trace data for the high-level `retrace` helper.
 *
 * Use this when you already have Tolk source-map data for the contract code
 * being retraced.
 */
export interface RetraceSourceTraceOptions {
    /**
     * Source files that were used for compilation.
     */
    sourceBundle: SourceTraceBundleLayout
    /**
     * Tolk compilation output with symbol types and debug marks enabled.
     */
    sourceMap: TolkSourceMapData
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
 * Source files that participated in compilation.
 */
export interface SourceTraceBundleLayout {
    /**
     * Entrypoint path used for compilation, normalized the same way as paths in
     * `files` and in the compiler source map.
     */
    entrypoint: string
    /**
     * Source file paths. Use the same path format that appears in the compiler
     * source map.
     */
    files: readonly string[]
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
     * Source files that were used for compilation.
     */
    sourceBundle: SourceTraceBundleLayout
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
    entrypoint: string
    files: readonly SourceTraceFileInfo[]
    steps: readonly SourceTraceStep[]
    truncated: boolean
}

export interface SourceTraceFileInfo {
    path: string
    isEntrypoint: boolean
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

export interface OutMessage {
    hash: string
    source: string
    destination: string
    value: string
    fwd_fee: string
    ihr_fee: string
    created_lt: string
    created_at: string
    opcode: string
    ihr_disabled: boolean
    bounce: boolean
    bounced: boolean
    import_fee: string
    message_content: {
        hash: string
        body: string
        decoded: Record<string, unknown>
    }
    init_state: {
        hash: string
        body: string
    }
}

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
    destroyed: boolean
    credit_first: boolean
    storage_ph?: {
        storage_fees_collected: string
        status_change: string
    }
    credit_ph?: {
        credit: string
    }
    compute_ph?: {
        skipped: boolean
        success: boolean
        msg_state_used: boolean
        account_activated: boolean
        gas_fees: string
        gas_used: string
        gas_limit: string
        mode: number
        exit_code: number
        vm_steps: number
        vm_init_state_hash: string
        vm_final_state_hash: string
    }
    action?: {
        success: boolean
        valid: boolean
        no_funds: boolean
        status_change: string
        result_code: number
        tot_actions: number
        spec_actions: number
        skipped_actions: number
        msgs_created: number
        action_list_hash: string
        tot_msg_size: {
            cells: string
            bits: string
        }
    }
}

export interface BlockRef {
    workchain: number
    shard: string
    seqno: number
}

export interface InMessage {
    hash: string
    source?: string | null
    destination?: string | null
    value: string
    value_extra_currencies: Record<string, unknown>
    fwd_fee: string
    ihr_fee: string
    created_lt: string
    created_at: number
    opcode: string
    ihr_disabled: boolean
    bounce: boolean
    bounced: boolean
    import_fee: string | null
    message_content: {
        hash: string
        body: string
        decoded: Record<string, unknown>
    }
    init_state: {
        hash: string
        body: string
    }
}

export interface AccountState {
    hash: string
    balance: string
    extra_currencies: Record<string, unknown>
    account_status: string
    frozen_hash: string | null
    data_hash: string
    code_hash: string
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
     * Source-level Tolk trace, present only when retrace is called with sourceTrace options.
     */
    sourceTrace?: SourceTraceResponse
    emulatorVersion: {
        commitHash: string
        commitDate: string
    }
}
