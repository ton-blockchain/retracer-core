import {Buffer} from "node:buffer"
import {
  Address,
  beginCell,
  Cell,
  loadShardAccount,
  loadTransaction,
  storeTransaction,
  type Transaction,
} from "@ton/core"
import type {EmulationResultSuccess, PrevBlocksInfo} from "@ton/sandbox/dist/executor/Executor"
import {logs} from "@ton/tasm"
import {
  type BaseTxInfo,
  collectUsedLibraries,
  computeFinalData,
  detectPrevBlocksUsage,
  emulatePreviousTransactions,
  findAllTransactionsBetween,
  findBaseTxByHash,
  findFinalActions,
  findMinLtInShardBlock,
  findRawTxByHash,
  findShardBlockForTx,
  getBlockAccount,
  getBlockConfig,
  getLibraryByHash,
  getPrevBlocksInfo,
  prepareEmulator,
  shardAccountToBase64,
} from "./methods"
import {toncenterHashToBuffer, toncenterV3Get} from "./networks"
import {buildSourceTraceForTraceResult} from "./sourceTrace"
import type {
  Block,
  RawTransaction,
  RetraceNetworkConfig,
  RetraceOptions,
  Transaction as ToncenterTransaction,
  TraceData,
  TraceReplayResult,
  TraceResult,
} from "./types"

/**
 * Fully reproduce (re‑trace) a TON transaction inside a local TON Sandbox
 * and return a structured report with VM logs, money flow, generated
 * actions and other data.
 *
 * Workflow (high level)
 * 1.  Locate the base transaction (`txLink`) via the provided Toncenter-compatible network.
 * 2.  Load its shard-block and the enclosing master-block; extract
 *     `rand_seed`, config‑cell and the account snapshot *prior* to the block.
 * 3.  Re‑create the exact pre‑tx state by sequentially emulating all earlier
 *     account transactions that happened inside the same master‑block.
 * 4.  Emulate the target transaction itself with full VM verbosity.
 * 5.  Parse the resulting VM log (`c5`, action list, stack trace), compare the
 *     calculated state‑hash with the on‑chain one and assemble a
 *     `TraceResult` object for the caller.
 *
 * @param network Toncenter-compatible network configuration.
 * @param txLink  Hex hash that uniquely identifies the transaction to retrace.
 * @param options Additional libraries and retrace options.
 *
 * @returns        A {@link TraceResult} containing:
 *                 1. an integrity flag `stateUpdateHashOk`
 *                 2. decoded an incoming message (sender / contract / amount)
 *                 3. balance delta, gas and fees
 *                 4. full emulated transaction (`emulatedTx`) with
 *                   compute‑phase info, `c5`, action list and raw VM log
 *                 5. version of the sandbox executor used for emulation
 *
 * @throws Error   If a network lookup fails; if the corresponding shard- or
 *                 masterchain block cannot be found; if a required library or
 *                 block context cannot be loaded; or if deterministic replay
 *                 fails before the target transaction can be reproduced.
 */
export const retrace = async (
  network: RetraceNetworkConfig,
  txLink: string,
  options: RetraceOptions = {},
): Promise<TraceResult> => {
  const baseTx = await findBaseTxByHash(network, txLink)
  if (baseTx === undefined) {
    throw new Error("Cannot find transaction info")
  }
  const dynamicLibs = [...(options.additionalLibs ?? [])]
  const loadedDynamicLibraries = new Set(dynamicLibs.map(([hash]) => hash.toString(16)))

  for (;;) {
    let result: TraceResult
    try {
      result = await retraceBaseTx(network, baseTx, dynamicLibs, options.sourceMap)
    } catch (error) {
      if (!(error instanceof MissingLibraryError)) {
        throw error
      }

      const [hash] = error.library
      const hashKey = hash.toString(16)
      if (loadedDynamicLibraries.has(hashKey)) {
        throw error
      }
      dynamicLibs.push(error.library)
      loadedDynamicLibraries.add(hashKey)
      continue
    }

    const library = await tryLoadMissingLibraryFromResult(result, network)
    if (!library) {
      return result
    }

    const [hash] = library
    const hashKey = hash.toString(16)
    if (loadedDynamicLibraries.has(hashKey)) {
      throw new Error(`Library ${hashKey} is still unavailable after loading`)
    }
    dynamicLibs.push(library)
    loadedDynamicLibraries.add(hashKey)
  }
}

interface TraceReplayTransaction {
  hash: string
  baseTx: BaseTxInfo
}

interface TraceReplayCaches {
  rawTransactions: Map<string, Promise<RawTransaction>>
  blockContexts: Map<string, Promise<TraceReplayBlockContext>>
  accountStates: Map<string, TraceReplayAccountState>
}

interface TraceReplayBlockContext {
  blockKey: string
  mcSeqno: number
  blockConfig: string
  randSeed: Buffer
  getPrevBlocksInfo: (with100: boolean) => Promise<PrevBlocksInfo | undefined>
}

interface TraceReplayAccountState {
  blockKey: string
  lt: bigint
  balance: bigint
  shardAccountBase64: string
}

interface TraceReplayEmulation {
  emulatorVersion: {
    commitHash: string
    commitDate: string
  }
  logs: string
  result: EmulationResultSuccess
  prevBalance: bigint
  shardAccountBeforeTargetBase64: string
  stateUpdateHashOk: boolean
}

class MissingLibraryError extends Error {
  public constructor(public readonly library: [bigint, Cell]) {
    super(`Missing library ${library[0].toString(16)}`)
    this.name = "MissingLibraryError"
  }
}

/**
 * Reproduce every transaction in the complete message trace containing `txHash`.
 *
 * The supplied hash may identify any transaction in the trace. Transactions are replayed
 * sequentially in Toncenter's canonical `transactions_order` when available, with logical-time
 * and trace-tree fallbacks for compatible endpoints that omit it. Per-account states are carried
 * forward between transactions in the same block.
 *
 * Missing public libraries are loaded automatically and cause the replay to restart with the
 * expanded library set. Use {@link RetraceOptions.additionalLibs} for libraries that cannot be
 * resolved through the configured endpoint.
 *
 * @param network Toncenter-compatible network configuration.
 * @param txHash  Hex hash of any transaction in the trace.
 * @param options Additional libraries and optional source-map data.
 * @returns       The normalized root hash, one {@link TraceResult} per transaction, an aggregate
 *                state-update verification flag, and the sandbox executor version.
 * @throws Error  If the trace is missing, incomplete or empty; if it references an unavailable
 *                transaction; if required block context or libraries cannot be loaded; or if
 *                deterministic transaction emulation fails.
 */
export const retraceTrace = async (
  network: RetraceNetworkConfig,
  txHash: string,
  options: RetraceOptions = {},
): Promise<TraceReplayResult> => {
  const trace = await loadTraceByTransactionHash(network, txHash)
  if (trace.is_incomplete) {
    throw new Error("Cannot replay an incomplete trace")
  }
  const traceTransactions = orderedTraceTransactions(trace)
  if (traceTransactions.length === 0) {
    throw new Error("Trace does not contain transactions")
  }

  const dynamicLibs = [...(options.additionalLibs ?? [])]
  const loadedDynamicLibraries = new Set(dynamicLibs.map(([hash]) => hash.toString(16)))

  for (;;) {
    const caches: TraceReplayCaches = {
      rawTransactions: new Map(),
      blockContexts: new Map(),
      accountStates: new Map(),
    }
    const results: Record<string, TraceResult> = {}
    let missingLibrary: [bigint, Cell] | undefined

    for (const traceTransaction of traceTransactions) {
      let result: TraceResult
      try {
        result = await replayTraceTransaction(network, traceTransaction, dynamicLibs, {
          sourceMap: options.sourceMap,
          caches,
        })
      } catch (error) {
        if (!(error instanceof MissingLibraryError)) {
          throw error
        }

        const [hash] = error.library
        const hashKey = hash.toString(16)
        if (loadedDynamicLibraries.has(hashKey)) {
          throw error
        }
        missingLibrary = error.library
        loadedDynamicLibraries.add(hashKey)
        break
      }
      results[traceTransaction.hash] = result

      const library = await tryLoadMissingLibraryFromResult(result, network)
      if (library) {
        const [hash] = library
        const hashKey = hash.toString(16)
        if (loadedDynamicLibraries.has(hashKey)) {
          throw new Error(`Library ${hashKey} is still unavailable after loading`)
        }
        missingLibrary = library
        loadedDynamicLibraries.add(hashKey)
        break
      }
    }

    if (missingLibrary) {
      dynamicLibs.push(missingLibrary)
      continue
    }

    const firstResult = results[traceTransactions[0].hash]

    return {
      rootTxHash: normalizeTraceHash(trace.trace.tx_hash),
      transactions: results,
      stateUpdateHashOk: Object.values(results).every(result => result.stateUpdateHashOk),
      emulatorVersion: firstResult.emulatorVersion,
    }
  }
}

/**
 * Fully reproduce (re‑trace) a TON transaction inside a local TON Sandbox
 * and return a structured report with VM logs, money flow, generated
 * actions and other data.
 *
 * See {@link retrace} for the full description of the workflow.
 */
export const retraceBaseTx = async (
  network: RetraceNetworkConfig,
  baseTx: BaseTxInfo,
  additionalLibs: [bigint, Cell][] = [],
  sourceMap?: RetraceOptions["sourceMap"],
): Promise<TraceResult> => {
  const tx = await findRawTxByHash(network, baseTx)
  const shard = tx.block
  const block = await findShardBlockForTx(network, tx)
  if (block === undefined) {
    throw new Error("Cannot find shard block for transaction")
  }
  // check if we correctly select master-block
  if (shard.rootHash.length > 0 && block.root_hash !== shard.rootHash) {
    throw new Error(
      `root_hash mismatch in mc_seqno getter: ${shard.rootHash} != ${block.root_hash}`,
    )
  }

  // master‑block sequence number that references our shard‑block
  const mcSeqno = block.masterchain_block_ref.seqno
  // pseudorandom seed from the master‑block header — TVM needs it for deterministic RNG
  const randSeed = Buffer.from(block.rand_seed, "base64")
  // determine the earliest logical-time (lt) for this account in the same shard block
  const minLt = await findMinLtInShardBlock(network, baseTx.address, tx.block, tx.tx.lt)
  // find all transactions between the earliest one and the emulated transaction to correctly
  // recreate all state before execution of the emulated transaction
  const transactionsInBlock = await findAllTransactionsBetween(network, baseTx, minLt)
  if (transactionsInBlock.length === 0) {
    throw new Error("getTransactions range does not contain requested transaction")
  }
  const [ourTx, ...prevTxsInBlock] = transactionsInBlock as [Transaction, ...Transaction[]]
  if (ourTx.lt !== tx.tx.lt) {
    throw new Error("getTransactions range does not contain requested transaction")
  }
  prevTxsInBlock.reverse() // allTxs contains txs from last to first one

  // retrieve block config to pass it to emulator
  const blockConfig = await getBlockConfig(network, mcSeqno)
  const shardAccountBeforeTx = await getBlockAccount(network, baseTx.address, mcSeqno)
  const [libs, loadedCode] = await collectUsedLibraries(
    network,
    shardAccountBeforeTx,
    tx.tx,
    additionalLibs,
  )

  // retrieve code cell if an account in active mode
  const state = shardAccountBeforeTx.account?.storage.state
  const codeCell =
    state?.type === "active"
      ? (state.state.code ?? undefined)
      : (tx.tx.inMessage?.init?.code ?? undefined)

  // for tick-tock transactions, mark the account as special in its StateInit
  // the API doesn't return this field, but the emulator needs it for correct state hashing
  if (ourTx.description.type === "tick-tock" && state?.type === "active") {
    const isTock = ourTx.description.isTock
    state.state.special = {tick: !isTock, tock: isTock}
  }

  // for the first transaction (executor doesn't know about last tx)
  shardAccountBeforeTx.lastTransactionLt = 0n
  shardAccountBeforeTx.lastTransactionHash = 0n

  // emulator accepts and returns a shard account in base64 string, so prepare it for sending
  const initialShardAccountBase64 = shardAccountToBase64(shardAccountBeforeTx)
  const balance = shardAccountBeforeTx.account?.storage.balance.coins ?? 0n

  const fetchPrevBlocksInfo = async (with100: boolean): Promise<PrevBlocksInfo | undefined> => {
    if (mcSeqno <= 1) {
      return undefined
    }

    return getPrevBlocksInfo(network, mcSeqno, {with100})
  }

  const runEmulation = async (prevBlocksInfo?: PrevBlocksInfo) => {
    const {emulatorVersion, emulate, emulateTickTock} = await prepareEmulator(
      blockConfig,
      libs,
      randSeed,
      prevBlocksInfo,
    )

    // wrapper that dispatches to emulate or emulateTickTock depending on tx type
    const emulateAny = async (tx: Transaction, sa: string) => {
      if (tx.description.type === "tick-tock") {
        const which = tx.description.isTock ? "tock" : "tick"
        return emulateTickTock(which, tx, sa)
      }
      return emulate(tx, sa)
    }

    // first we emulate all transactions before to get a state that is equal to actual
    // state in blockchain before transaction to emulate
    const {prevBalance, shardAccountBase64} = await emulatePreviousTransactions(
      balance,
      prevTxsInBlock,
      emulateAny,
      initialShardAccountBase64,
      async result => {
        const library = await tryLoadMissingLibraryFromVmLogs(result.vmLog, network)
        if (library) {
          throw new MissingLibraryError(library)
        }
      },
    )
    const shardAccountBeforeTargetBase64 = shardAccountBase64

    // and then we emulate the target transaction
    const txRes = await emulateAny(ourTx, shardAccountBase64)
    if (!txRes.result.success) {
      throw new Error(`Transaction failed: ${txRes.result.error}`)
    }

    // check if the emulated transaction hash is equal to one from the real blockchain
    const emulated = loadTransaction(Cell.fromBase64(txRes.result.transaction).asSlice())
    const stateUpdateHashOk = emulated.stateUpdate.newHash.equals(ourTx.stateUpdate.newHash)

    return {
      emulatorVersion,
      logs: txRes.logs,
      result: txRes.result,
      prevBalance,
      shardAccountBeforeTargetBase64,
      stateUpdateHashOk,
    }
  }

  // prev_blocks_info costs a couple of dozen toncenter requests,
  // so fetch it only when the code actually reads it
  const prevBlocksUsage = detectPrevBlocksUsage([codeCell, loadedCode])
  const prevBlocksInfo = prevBlocksUsage.needed
    ? await fetchPrevBlocksInfo(prevBlocksUsage.with100)
    : undefined

  let emulation = await runEmulation(prevBlocksInfo)

  // the detection above is static and cannot see dynamically composed
  // code (e.g. a continuation built from data or a message body), so
  // when the state diverged without the full prev_blocks_info, retry
  // once with everything fetched
  if (!emulation.stateUpdateHashOk && prevBlocksInfo?.lastMcBlocks100 === undefined) {
    const fullPrevBlocksInfo = await fetchPrevBlocksInfo(true)
    if (fullPrevBlocksInfo !== undefined) {
      emulation = await runEmulation(fullPrevBlocksInfo)
    }
  }

  const {
    emulatorVersion,
    prevBalance,
    shardAccountBeforeTargetBase64,
    stateUpdateHashOk,
    result: emulationResult,
    logs: executorLogs,
  } = emulation

  // extract out actions from the c5 control register
  const {finalActions, c5} = findFinalActions(emulationResult)

  const {sender, contract, amount, money, emulatedTx, computeInfo} = computeFinalData(
    emulationResult,
    prevBalance,
    baseTx.address,
  )

  const opcode = txOpcode(ourTx)

  const result: TraceResult = {
    stateUpdateHashOk,
    codeCell: loadedCode ?? codeCell,
    originalCodeCell: codeCell,
    inMsg: {
      sender,
      contract,
      amount,
      opcode,
    },
    account: {
      shardAccountBefore: shardAccountBeforeTargetBase64,
      shardAccountAfter: emulationResult.shardAccount,
    },
    money,
    emulatedTx: {
      raw: beginCell().store(storeTransaction(ourTx)).endCell().toBoc().toString("hex"),
      utime: emulatedTx.now,
      lt: emulatedTx.lt,
      computeInfo,
      executorLogs,
      actions: finalActions,
      c5: c5,
      vmLogs: emulationResult.vmLog,
    },
    emulatorVersion,
  }

  if (sourceMap) {
    return {
      ...result,
      sourceTrace: await buildSourceTraceForTraceResult(result, sourceMap),
    }
  }

  return result
}

async function loadTraceByTransactionHash(
  network: RetraceNetworkConfig,
  txHash: string,
): Promise<TraceData["traces"][number]> {
  const data = await toncenterV3Get<TraceData>(network, "traces", {tx_hash: txHash})
  const trace = data.traces.at(0)
  if (!trace) {
    throw new Error("Cannot find trace for transaction")
  }
  return trace
}

function orderedTraceTransactions(trace: TraceData["traces"][number]): TraceReplayTransaction[] {
  const transactionsByHash: Map<string, ToncenterTransaction> = new Map()

  for (const [mapKey, transaction] of Object.entries(trace.transactions)) {
    transactionsByHash.set(normalizeTraceHash(mapKey), transaction)
    transactionsByHash.set(normalizeTraceHash(transaction.hash), transaction)
  }

  const orderedHashes: string[] = []
  const seenHashes: Set<string> = new Set()
  const pushHash = (hash: string | undefined): void => {
    if (hash === undefined || hash.length === 0) return
    const normalized = normalizeTraceHash(hash)
    if (seenHashes.has(normalized)) return
    seenHashes.add(normalized)
    orderedHashes.push(normalized)
  }

  const visitNode = (node: TraceData["traces"][number]["trace"] | undefined): void => {
    if (!node) return
    pushHash(node.tx_hash)
    for (const child of node.children ?? []) {
      visitNode(child)
    }
  }

  for (const hash of trace.transactions_order ?? []) {
    pushHash(hash)
  }
  for (const transaction of Object.values(trace.transactions).sort(compareApiTransactionLt)) {
    pushHash(transaction.hash)
  }
  visitNode(trace.trace)

  return orderedHashes.map(hash => {
    const transaction = transactionsByHash.get(hash)
    if (!transaction) {
      throw new Error(`Trace references unavailable transaction ${hash}`)
    }
    return {
      hash,
      baseTx: baseTxFromTraceTransaction(transaction),
    }
  })
}

async function replayTraceTransaction(
  network: RetraceNetworkConfig,
  traceTransaction: TraceReplayTransaction,
  additionalLibs: [bigint, Cell][],
  options: {
    sourceMap?: RetraceOptions["sourceMap"]
    caches: TraceReplayCaches
  },
): Promise<TraceResult> {
  const {baseTx} = traceTransaction
  const rawTx = await cachedRawTransaction(network, baseTx, options.caches)
  const blockContext = await cachedBlockContext(network, rawTx, options.caches)
  const accountKey = baseTx.address.toString()
  const cachedAccountState = options.caches.accountStates.get(accountKey)

  const replayRange =
    cachedAccountState &&
    cachedAccountState.blockKey === blockContext.blockKey &&
    cachedAccountState.lt < rawTx.tx.lt
      ? await replayRangeFromCachedState(network, baseTx, rawTx, cachedAccountState)
      : await replayRangeFromBlockState(network, baseTx, rawTx, blockContext)

  const accountBeforeRun = loadShardAccount(
    Cell.fromBase64(replayRange.shardAccountBase64).asSlice(),
  )
  const [libs, loadedCode] = await collectUsedLibraries(
    network,
    accountBeforeRun,
    replayRange.targetTx,
    additionalLibs,
  )
  const codeCell = accountCodeCell(accountBeforeRun, replayRange.targetTx)
  const initialShardAccountBase64 = shardAccountToBase64(
    accountWithTickTockSpecial(accountBeforeRun, replayRange.targetTx),
  )

  const runEmulation = async (prevBlocksInfo?: PrevBlocksInfo): Promise<TraceReplayEmulation> => {
    const {emulatorVersion, emulate, emulateTickTock} = await prepareEmulator(
      blockContext.blockConfig,
      libs,
      blockContext.randSeed,
      prevBlocksInfo,
    )

    const emulateAny = async (tx: Transaction, shardAccountBase64: string) => {
      if (tx.description.type === "tick-tock") {
        const which = tx.description.isTock ? "tock" : "tick"
        return emulateTickTock(which, tx, shardAccountBase64)
      }
      return emulate(tx, shardAccountBase64)
    }

    const {prevBalance, shardAccountBase64} = await emulatePreviousTransactions(
      replayRange.balance,
      replayRange.prevTxs,
      emulateAny,
      initialShardAccountBase64,
      async result => {
        const library = await tryLoadMissingLibraryFromVmLogs(result.vmLog, network)
        if (library) {
          throw new MissingLibraryError(library)
        }
      },
    )
    const shardAccountBeforeTargetBase64 = shardAccountBase64
    const txRes = await emulateAny(replayRange.targetTx, shardAccountBase64)
    if (!txRes.result.success) {
      throw new Error(`Transaction failed: ${txRes.result.error}`)
    }

    const emulated = loadTransaction(Cell.fromBase64(txRes.result.transaction).asSlice())
    const stateUpdateHashOk = emulated.stateUpdate.newHash.equals(
      replayRange.targetTx.stateUpdate.newHash,
    )

    return {
      emulatorVersion,
      logs: txRes.logs,
      result: txRes.result,
      prevBalance,
      shardAccountBeforeTargetBase64,
      stateUpdateHashOk,
    }
  }

  const prevBlocksUsage = detectPrevBlocksUsage([codeCell, loadedCode])
  const prevBlocksInfo = prevBlocksUsage.needed
    ? await blockContext.getPrevBlocksInfo(prevBlocksUsage.with100)
    : undefined

  let emulation = await runEmulation(prevBlocksInfo)
  if (!emulation.stateUpdateHashOk && prevBlocksInfo?.lastMcBlocks100 === undefined) {
    const fullPrevBlocksInfo = await blockContext.getPrevBlocksInfo(true)
    if (fullPrevBlocksInfo !== undefined) {
      emulation = await runEmulation(fullPrevBlocksInfo)
    }
  }

  const result = await buildTraceResult({
    baseTx,
    tx: replayRange.targetTx,
    emulation,
    loadedCode,
    codeCell,
    sourceMap: options.sourceMap,
  })

  if (result.stateUpdateHashOk) {
    const shardAccountAfter = loadShardAccount(
      Cell.fromBase64(result.account.shardAccountAfter).asSlice(),
    )
    options.caches.accountStates.set(accountKey, {
      blockKey: blockContext.blockKey,
      lt: replayRange.targetTx.lt,
      balance: shardAccountAfter.account?.storage.balance.coins ?? 0n,
      shardAccountBase64: result.account.shardAccountAfter,
    })
  } else {
    options.caches.accountStates.delete(accountKey)
  }

  return result
}

async function replayRangeFromCachedState(
  network: RetraceNetworkConfig,
  baseTx: BaseTxInfo,
  rawTx: RawTransaction,
  cachedAccountState: TraceReplayAccountState,
): Promise<{
  targetTx: Transaction
  prevTxs: Transaction[]
  balance: bigint
  shardAccountBase64: string
}> {
  const transactions = await findAllTransactionsBetween(network, baseTx, cachedAccountState.lt + 1n)
  if (transactions.length === 0) {
    throw new Error("getTransactions range does not contain requested transaction")
  }
  const [targetTx, ...prevTxs] = transactions as [Transaction, ...Transaction[]]
  if (targetTx.lt !== rawTx.tx.lt) {
    throw new Error("getTransactions range does not contain requested transaction")
  }
  prevTxs.reverse()
  return {
    targetTx,
    prevTxs,
    balance: cachedAccountState.balance,
    shardAccountBase64: cachedAccountState.shardAccountBase64,
  }
}

async function replayRangeFromBlockState(
  network: RetraceNetworkConfig,
  baseTx: BaseTxInfo,
  rawTx: RawTransaction,
  blockContext: TraceReplayBlockContext,
): Promise<{
  targetTx: Transaction
  prevTxs: Transaction[]
  balance: bigint
  shardAccountBase64: string
}> {
  const minLt = await findMinLtInShardBlock(network, baseTx.address, rawTx.block, rawTx.tx.lt)
  const transactions = await findAllTransactionsBetween(network, baseTx, minLt)
  if (transactions.length === 0) {
    throw new Error("getTransactions range does not contain requested transaction")
  }
  const [targetTx, ...prevTxs] = transactions as [Transaction, ...Transaction[]]
  if (targetTx.lt !== rawTx.tx.lt) {
    throw new Error("getTransactions range does not contain requested transaction")
  }
  prevTxs.reverse()

  const shardAccountBeforeTx = await getBlockAccount(network, baseTx.address, blockContext.mcSeqno)
  shardAccountBeforeTx.lastTransactionLt = 0n
  shardAccountBeforeTx.lastTransactionHash = 0n

  return {
    targetTx,
    prevTxs,
    balance: shardAccountBeforeTx.account?.storage.balance.coins ?? 0n,
    shardAccountBase64: shardAccountToBase64(shardAccountBeforeTx),
  }
}

async function cachedRawTransaction(
  network: RetraceNetworkConfig,
  baseTx: BaseTxInfo,
  caches: TraceReplayCaches,
): Promise<RawTransaction> {
  const hash = baseTx.hash.toString("hex")
  let rawTx = caches.rawTransactions.get(hash)
  if (!rawTx) {
    rawTx = findRawTxByHash(network, baseTx)
    caches.rawTransactions.set(hash, rawTx)
  }
  return rawTx
}

async function cachedBlockContext(
  network: RetraceNetworkConfig,
  rawTx: RawTransaction,
  caches: TraceReplayCaches,
): Promise<TraceReplayBlockContext> {
  const blockKey = rawBlockKey(rawTx)
  let context = caches.blockContexts.get(blockKey)
  if (!context) {
    context = loadBlockContext(network, rawTx)
    caches.blockContexts.set(blockKey, context)
  }
  return context
}

async function loadBlockContext(
  network: RetraceNetworkConfig,
  rawTx: RawTransaction,
): Promise<TraceReplayBlockContext> {
  const block = await findShardBlockForTx(network, rawTx)
  if (block === undefined) {
    throw new Error("Cannot find shard block for transaction")
  }
  if (rawTx.block.rootHash.length > 0 && block.root_hash !== rawTx.block.rootHash) {
    throw new Error(
      `root_hash mismatch in mc_seqno getter: ${rawTx.block.rootHash} != ${block.root_hash}`,
    )
  }

  const mcSeqno = block.masterchain_block_ref.seqno
  const blockConfig = await getBlockConfig(network, mcSeqno)
  const randSeed = blockRandSeed(block)
  const prevBlocksInfo: Map<string, Promise<PrevBlocksInfo | undefined>> = new Map()
  const getCachedPrevBlocksInfo = async (with100: boolean): Promise<PrevBlocksInfo | undefined> => {
    if (mcSeqno <= 1) {
      return undefined
    }
    const key = with100 ? "full" : "short"
    let request = prevBlocksInfo.get(key)
    if (!request) {
      request = getPrevBlocksInfo(network, mcSeqno, {with100})
      prevBlocksInfo.set(key, request)
    }
    return request
  }

  return {
    blockKey: rawBlockKey(rawTx),
    mcSeqno,
    blockConfig,
    randSeed,
    getPrevBlocksInfo: getCachedPrevBlocksInfo,
  }
}

async function buildTraceResult({
  baseTx,
  tx,
  emulation,
  loadedCode,
  codeCell,
  sourceMap,
}: {
  baseTx: BaseTxInfo
  tx: Transaction
  emulation: TraceReplayEmulation
  loadedCode: Cell | undefined
  codeCell: Cell | undefined
  sourceMap?: RetraceOptions["sourceMap"]
}): Promise<TraceResult> {
  const {finalActions, c5} = findFinalActions(emulation.result)
  const {sender, contract, amount, money, emulatedTx, computeInfo} = computeFinalData(
    emulation.result,
    emulation.prevBalance,
    baseTx.address,
  )
  const result: TraceResult = {
    stateUpdateHashOk: emulation.stateUpdateHashOk,
    codeCell: loadedCode ?? codeCell,
    originalCodeCell: codeCell,
    inMsg: {
      sender,
      contract,
      amount,
      opcode: txOpcode(tx),
    },
    account: {
      shardAccountBefore: emulation.shardAccountBeforeTargetBase64,
      shardAccountAfter: emulation.result.shardAccount,
    },
    money,
    emulatedTx: {
      raw: beginCell().store(storeTransaction(tx)).endCell().toBoc().toString("hex"),
      utime: emulatedTx.now,
      lt: emulatedTx.lt,
      computeInfo,
      executorLogs: emulation.logs,
      actions: finalActions,
      c5,
      vmLogs: emulation.result.vmLog,
    },
    emulatorVersion: emulation.emulatorVersion,
  }

  if (sourceMap) {
    return {
      ...result,
      sourceTrace: await buildSourceTraceForTraceResult(result, sourceMap),
    }
  }

  return result
}

function blockRandSeed(block: Block): Buffer {
  const value = block.rand_seed.trim()
  if (!value) {
    throw new Error("Block rand_seed is missing")
  }
  const buffer = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  if (buffer.length !== 32) {
    throw new Error("Block rand_seed must contain 32 bytes")
  }
  return buffer
}

async function tryLoadMissingLibraryFromResult(
  result: TraceResult,
  network: RetraceNetworkConfig,
): Promise<[bigint, Cell] | undefined> {
  if (result.emulatedTx.computeInfo === "skipped" || result.emulatedTx.computeInfo.exitCode !== 9) {
    return undefined
  }

  return tryLoadMissingLibraryFromVmLogs(result.emulatedTx.vmLogs, network)
}

async function tryLoadMissingLibraryFromVmLogs(
  vmLogs: string,
  network: RetraceNetworkConfig,
): Promise<[bigint, Cell] | undefined> {
  let lines: ReturnType<typeof logs.parse>
  try {
    lines = logs.parse(vmLogs)
  } catch {
    return undefined
  }
  const exceptionHandlerLine = lines.at(-2)
  const exceptionLine = lines.at(-3)
  const ctosLine = lines.at(-4)
  const stackLine = lines.at(-6)
  if (
    exceptionHandlerLine?.$ !== "VmExceptionHandler" ||
    exceptionLine?.$ !== "VmException" ||
    exceptionLine.message !== "failed to load library cell" ||
    ctosLine?.$ !== "VmExecute" ||
    ctosLine.instr !== "CTOS" ||
    stackLine?.$ !== "VmStack"
  ) {
    return undefined
  }

  const topElement = stackLine.stack.at(-1)
  if (topElement?.$ !== "Cell") {
    return undefined
  }

  const libraryResult = await tryLoadAsLibrary(topElement.boc, network)
  if (!libraryResult) {
    return undefined
  }

  return [BigInt(`0x${libraryResult.libHashHex}`), libraryResult.actualCode]
}

function accountCodeCell(shardAccountBase: ReturnType<typeof loadShardAccount>, tx: Transaction) {
  const state = shardAccountBase.account?.storage.state
  return state?.type === "active"
    ? (state.state.code ?? undefined)
    : (tx.inMessage?.init?.code ?? undefined)
}

function accountWithTickTockSpecial(
  shardAccount: ReturnType<typeof loadShardAccount>,
  tx: Transaction,
) {
  const state = shardAccount.account?.storage.state
  if (tx.description.type === "tick-tock" && state?.type === "active") {
    const isTock = tx.description.isTock
    state.state.special = {tick: !isTock, tock: isTock}
  }
  return shardAccount
}

function baseTxFromTraceTransaction(transaction: ToncenterTransaction): BaseTxInfo {
  return {
    lt: BigInt(transaction.lt),
    hash: toncenterHashToBuffer(transaction.hash),
    address: parseTraceAddress(transaction.account),
    block: transaction.block_ref,
  }
}

function parseTraceAddress(address: string): Address {
  try {
    return Address.parseRaw(address)
  } catch {
    return Address.parse(address)
  }
}

function normalizeTraceHash(hash: string): string {
  try {
    return toncenterHashToBuffer(hash).toString("hex")
  } catch {
    return hash.trim().replace(/^0x/i, "").toLowerCase()
  }
}

function rawBlockKey(rawTx: RawTransaction): string {
  return `${rawTx.block.workchain}:${rawTx.block.shard}:${rawTx.block.seqno}`
}

function compareApiTransactionLt(left: ToncenterTransaction, right: ToncenterTransaction): number {
  const leftLt = BigInt(left.lt)
  const rightLt = BigInt(right.lt)
  if (leftLt === rightLt) {
    return 0
  }
  return leftLt < rightLt ? -1 : 1
}

function txOpcode(transaction: Transaction): number | undefined {
  const inMessage = transaction.inMessage
  const isBounced = inMessage?.info.type === "internal" ? inMessage.info.bounced : false

  let opcode: number | undefined
  const slice = inMessage?.body.asSlice()
  if (slice) {
    if (isBounced) {
      // skip 0xFFFF..
      slice.loadUint(32)
    }
    if (slice.remainingBits >= 32) {
      opcode = slice.loadUint(32)
    }
  }

  return opcode
}

/**
 * Try to parse a given cell as a library cell and load it from the blockchain.
 */
async function tryLoadAsLibrary(
  cell: string,
  network: RetraceNetworkConfig,
): Promise<
  | {
      libHashHex: string
      actualCode: Cell
    }
  | undefined
> {
  const libCell = Cell.fromHex(cell)

  const EXOTIC_LIBRARY_TAG = 2
  if (libCell.bits.length !== 256 + 8) return undefined // not an exotic library cell

  const cs = libCell.beginParse(true) // allow exotics
  const tag = cs.loadUint(8)
  if (tag !== EXOTIC_LIBRARY_TAG) return undefined // not a library cell

  const libHash = cs.loadBuffer(32)
  const libHashHex = libHash.toString("hex").toUpperCase()
  const actualCode = await getLibraryByHash(network, libHashHex)
  return {libHashHex, actualCode}
}
