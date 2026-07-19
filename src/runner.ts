import {Buffer} from "node:buffer"
import {
  Address,
  beginCell,
  Cell,
  type AccountState as CoreAccountState,
  loadMessage,
  loadShardAccount,
  loadTransaction,
  type Message,
  type ShardAccount,
  storeShardAccount,
  storeStateInit,
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
  extractRawTransactionMessageCells,
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
  getShardAccountAtBlock,
  prepareEmulator,
  shardAccountToBase64,
} from "./methods"
import {toncenterHashToBuffer, toncenterV2Get, toncenterV3Get} from "./networks"
import {buildSourceTraceForTraceResult} from "./sourceTrace"
import type {
  Block,
  BlockRef,
  Description,
  EmulatedAccountState,
  EmulatedDescription,
  EmulatedMessage,
  EmulatedTrace,
  EmulatedTransaction,
  EmulateRawMessageOptions,
  EmulateRawMessageResult,
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

interface RawMessageBlockContext {
  mcSeqno: number
  blockConfig: string
  randSeed: Buffer
  now: number
  lt: bigint
  getPrevBlocksInfo: (with100: boolean) => Promise<PrevBlocksInfo | undefined>
}

interface GetMasterchainInfoResponse {
  ok: boolean
  error?: string
  code?: number
  result?: {
    last?: {
      seqno?: number
    }
  }
}

class MissingLibraryError extends Error {
  public constructor(public readonly library: [bigint, Cell]) {
    super(`Missing library ${library[0].toString(16)}`)
    this.name = "MissingLibraryError"
  }
}

const DEFAULT_RAW_MESSAGE_MAX_TRANSACTIONS = 128
const MAX_UINT32 = 4_294_967_295
const MAX_UINT64 = (1n << 64n) - 1n
const MAX_UINT256 = (1n << 256n) - 1n

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
 * Emulate a serialized inbound message and every internal message produced by it.
 *
 * The emulation starts from the state produced by `options.mcSeqno`, or the latest
 * masterchain block when no seqno is provided. Unlike {@link retraceTrace}, this method
 * does not compare the resulting state updates with on-chain transactions.
 */
export const emulateRawMessage = async (
  network: RetraceNetworkConfig,
  rawMessage: Cell | string,
  options: EmulateRawMessageOptions = {},
): Promise<EmulateRawMessageResult> => {
  const messageCell = rawMessage instanceof Cell ? rawMessage : parseRawMessageCell(rawMessage)
  const dynamicLibs = [...(options.additionalLibs ?? [])]
  const loadedDynamicLibraries = new Set(dynamicLibs.map(([hash]) => hash.toString(16)))
  const mcSeqno = await resolveEmulationMcSeqno(network, options.mcSeqno)

  for (;;) {
    const result = await emulateRawMessageCascade(network, messageCell, mcSeqno, {
      ...options,
      additionalLibs: dynamicLibs,
    })

    let missingLibrary: [bigint, Cell] | undefined
    for (const traceResult of Object.values(result.transactions)) {
      const library = await tryLoadMissingLibraryFromResult(traceResult, network)
      if (!library) {
        continue
      }

      const [hash] = library
      const hashKey = hash.toString(16)
      if (loadedDynamicLibraries.has(hashKey)) {
        throw new Error(`Library ${hashKey} is still unavailable after loading`)
      }
      missingLibrary = library
      loadedDynamicLibraries.add(hashKey)
      break
    }

    if (missingLibrary) {
      dynamicLibs.push(missingLibrary)
      continue
    }

    return result
  }
}

interface RawMessageQueueItem {
  message: Message
  messageCell: Cell
  parentHash?: string
}

interface RawMessageAccountState {
  shardAccountBase64: string
  balance: bigint
}

interface RawMessageEmulatedTransaction {
  hash: string
  parentHash?: string
  inMessageHash: string
  address: Address
  transaction: Transaction
  inMessageCell: Cell
  outMessageCells: ReadonlyMap<number, Cell>
  traceResult: TraceResult
  shardAccountBefore: string
  shardAccountAfter: string
}

async function emulateRawMessageCascade(
  network: RetraceNetworkConfig,
  messageCell: Cell,
  mcSeqno: number,
  options: EmulateRawMessageOptions,
): Promise<EmulateRawMessageResult> {
  const message = loadMessage(messageCell.asSlice())
  const destination = message.info.dest
  if (!Address.isAddress(destination)) {
    throw new Error("Raw message destination must be an account address")
  }

  const blockContext = await loadRawMessageBlockContext(network, mcSeqno, options)
  const maxTransactions = resolveRawMessageMaxTransactions(options.maxTransactions)
  const accountStates = await buildRawMessageAccountStateOverrides(
    network,
    mcSeqno,
    options.accountStateOverrides,
  )
  const queue: RawMessageQueueItem[] = [{message, messageCell}]
  const emulatedTransactions: RawMessageEmulatedTransaction[] = []
  let nextTransactionLt = blockContext.lt

  while (queue.length > 0) {
    if (emulatedTransactions.length >= maxTransactions) {
      throw new Error(`Raw message emulation exceeded ${maxTransactions} transactions`)
    }

    const item = queue.shift()
    if (!item) {
      continue
    }
    const txDestination = messageDestination(item.message)
    if (!txDestination) {
      continue
    }

    const accountState = await loadRawMessageAccountState(
      network,
      blockContext.mcSeqno,
      txDestination,
      accountStates,
    )
    const accountBeforeRun = loadShardAccount(
      Cell.fromBase64(accountState.shardAccountBase64).asSlice(),
    )
    const messageTx = {inMessage: item.message} as Transaction
    const [libs, loadedCode] = await collectUsedLibraries(
      network,
      accountBeforeRun,
      messageTx,
      options.additionalLibs ?? [],
    )
    const codeCell = accountCodeCell(accountBeforeRun, messageTx)
    const prevBlocksUsage = detectPrevBlocksUsage([codeCell, loadedCode])
    const prevBlocksInfo = prevBlocksUsage.needed
      ? await blockContext.getPrevBlocksInfo(prevBlocksUsage.with100)
      : undefined

    const {emulatorVersion, emulateMessage} = await prepareEmulator(
      blockContext.blockConfig,
      libs,
      blockContext.randSeed,
      prevBlocksInfo,
      {ignoreChksig: emulatedTransactions.length === 0 ? options.ignoreChksig : false},
    )
    const incomingCreatedLt =
      item.message.info.type === "internal" ? item.message.info.createdLt : 0n
    const transactionLt =
      nextTransactionLt > incomingCreatedLt ? nextTransactionLt : incomingCreatedLt + 1n
    const transactionResult = await emulateMessage(
      item.messageCell,
      accountState.shardAccountBase64,
      blockContext.now,
      transactionLt,
    )
    if (!transactionResult.result.success) {
      throw new Error(`Message emulation failed: ${transactionResult.result.error}`)
    }

    const transactionCell = Cell.fromBase64(transactionResult.result.transaction)
    const emulatedTransaction = loadTransaction(transactionCell.asSlice())
    const transactionMessageCells = extractRawTransactionMessageCells(emulatedTransaction)
    const inMessageCell = transactionMessageCells.inMessage
    if (!inMessageCell) {
      throw new Error("Emulated transaction does not contain its inbound message")
    }
    nextTransactionLt = emulatedTransaction.lt + 1n
    const hash = transactionCell.hash().toString("hex")
    const emulation: TraceReplayEmulation = {
      emulatorVersion,
      logs: transactionResult.logs,
      result: transactionResult.result,
      prevBalance: accountState.balance,
      shardAccountBeforeTargetBase64: accountState.shardAccountBase64,
      stateUpdateHashOk: true,
    }
    const baseTx: BaseTxInfo = {
      lt: emulatedTransaction.lt,
      hash: Buffer.from(hash, "hex"),
      address: txDestination,
      block: rawMessageBlockRef(blockContext),
    }
    const builtTraceResult = await buildTraceResult({
      baseTx,
      tx: emulatedTransaction,
      emulation,
      loadedCode,
      codeCell,
      sourceMap: options.sourceMap,
    })
    const traceResult: TraceResult = {
      ...builtTraceResult,
      emulatedTx: {
        ...builtTraceResult.emulatedTx,
        raw: transactionCell.toBoc().toString("hex"),
      },
    }

    accountStates.set(txDestination.toString(), {
      shardAccountBase64: transactionResult.result.shardAccount,
      balance:
        loadShardAccount(Cell.fromBase64(transactionResult.result.shardAccount).asSlice()).account
          ?.storage.balance.coins ?? 0n,
    })

    emulatedTransactions.push({
      hash,
      parentHash: item.parentHash,
      inMessageHash: inMessageCell.hash().toString("hex"),
      address: txDestination,
      transaction: emulatedTransaction,
      inMessageCell,
      outMessageCells: transactionMessageCells.outMessages,
      traceResult,
      shardAccountBefore: accountState.shardAccountBase64,
      shardAccountAfter: transactionResult.result.shardAccount,
    })

    for (const [index, outMessage] of emulatedTransaction.outMessages) {
      if (!messageDestination(outMessage)) {
        continue
      }
      const outMessageCell = transactionMessageCells.outMessages.get(index)
      if (!outMessageCell) {
        throw new Error(`Cannot extract raw outgoing message ${index}`)
      }

      queue.push({
        message: outMessage,
        messageCell: outMessageCell,
        parentHash: hash,
      })
    }
  }

  const root = emulatedTransactions.at(0)
  if (!root) {
    throw new Error("Raw message did not produce transactions")
  }

  return {
    rootTxHash: root.hash,
    transactions: Object.fromEntries(
      emulatedTransactions.map(transaction => [transaction.hash, transaction.traceResult] as const),
    ),
    trace: buildRawMessageToncenterTrace(root.hash, emulatedTransactions, blockContext),
    stateUpdateHashOk: true,
    emulatorVersion: root.traceResult.emulatorVersion,
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

function parseRawMessageCell(rawMessage: string): Cell {
  return parseBocCell(rawMessage, "Raw message")
}

async function buildRawMessageAccountStateOverrides(
  network: RetraceNetworkConfig,
  mcSeqno: number,
  overrides: EmulateRawMessageOptions["accountStateOverrides"] = {},
): Promise<Map<string, RawMessageAccountState>> {
  const accountStates = new Map<string, RawMessageAccountState>()

  for (const [addressString, override] of Object.entries(overrides)) {
    const address = Address.parse(addressString)
    const shardAccountBoc = override.shardAccountBoc
    const baseShardAccount =
      shardAccountBoc !== undefined
        ? loadShardAccount(parseBocCell(shardAccountBoc, "Account state override").asSlice())
        : await getShardAccountAtBlock(network, address, mcSeqno)
    if (baseShardAccount.account && !baseShardAccount.account.addr.equals(address)) {
      throw new Error(`Account state override address does not match ${address.toString()}`)
    }
    const shardAccount = applyRawMessageAccountStateOverride(address, baseShardAccount, override)
    const shardAccountCell = beginCell().store(storeShardAccount(shardAccount)).endCell()
    accountStates.set(address.toString(), {
      shardAccountBase64: shardAccountCell.toBoc().toString("base64"),
      balance: shardAccount.account?.storage.balance.coins ?? 0n,
    })
  }

  return accountStates
}

function applyRawMessageAccountStateOverride(
  address: Address,
  shardAccount: ShardAccount,
  override: NonNullable<EmulateRawMessageOptions["accountStateOverrides"]>[string],
): ShardAccount {
  const lastTransactionLt = parseOptionalUint(
    override.lastTransactionLt,
    "lastTransactionLt",
    MAX_UINT64,
  )
  if (lastTransactionLt === MAX_UINT64) {
    throw new Error("lastTransactionLt must leave room for the next transaction")
  }
  const lastTransactionHash = parseOptionalUint(
    override.lastTransactionHash,
    "lastTransactionHash",
    MAX_UINT256,
  )
  const storageLastTransactionLtOverride = parseOptionalUint(
    override.storageLastTransactionLt,
    "storageLastTransactionLt",
    MAX_UINT64,
  )
  const storageLastTransactionLt =
    storageLastTransactionLtOverride ??
    (lastTransactionLt === undefined
      ? undefined
      : lastTransactionLt === 0n
        ? 0n
        : lastTransactionLt + 1n)

  const accountRequired =
    override.balance !== undefined ||
    override.state !== undefined ||
    storageLastTransactionLt !== undefined
  const baseAccount = shardAccount.account ?? (accountRequired ? createEmptyAccount(address) : null)

  const nextShardAccount: ShardAccount = {
    account: baseAccount,
    lastTransactionHash: lastTransactionHash ?? shardAccount.lastTransactionHash,
    lastTransactionLt: lastTransactionLt ?? shardAccount.lastTransactionLt,
  }

  if (baseAccount) {
    const balance = parseOptionalUint(override.balance, "balance")
    nextShardAccount.account = {
      ...baseAccount,
      storage: {
        ...baseAccount.storage,
        lastTransLt: storageLastTransactionLt ?? baseAccount.storage.lastTransLt,
        balance:
          balance === undefined
            ? baseAccount.storage.balance
            : {
                ...baseAccount.storage.balance,
                coins: balance,
              },
        state: override.state
          ? applyRawMessageAccountStateDataOverride(baseAccount.storage.state, override.state)
          : baseAccount.storage.state,
      },
    }
  }

  return nextShardAccount
}

function createEmptyAccount(address: Address): NonNullable<ShardAccount["account"]> {
  return {
    addr: address,
    storageStats: {
      used: {
        bits: 0n,
        cells: 0n,
      },
      storageExtra: null,
      lastPaid: 0,
      duePayment: null,
    },
    storage: {
      lastTransLt: 0n,
      balance: {
        coins: 0n,
      },
      state: {
        type: "uninit",
      },
    },
  }
}

function applyRawMessageAccountStateDataOverride(
  baseState: CoreAccountState,
  override: NonNullable<EmulateRawMessageOptions["accountStateOverrides"]>[string]["state"],
): CoreAccountState {
  if (!override) {
    return baseState
  }

  if (override.type === "uninit") {
    return {type: "uninit"}
  }

  if (override.type === "frozen") {
    return {
      type: "frozen",
      stateHash:
        parseOptionalUint(override.stateHash, "stateHash", MAX_UINT256) ??
        (baseState.type === "frozen" ? baseState.stateHash : 0n),
    }
  }

  const baseActiveState = baseState.type === "active" ? baseState.state : {}
  const code = parseOptionalOverrideCell(override.codeBoc, "codeBoc", baseActiveState.code)
  const data = parseOptionalOverrideCell(override.dataBoc, "dataBoc", baseActiveState.data)

  return {
    type: "active",
    state: {
      ...baseActiveState,
      code,
      data,
    },
  }
}

function parseOptionalOverrideCell(
  value: string | null | undefined,
  label: string,
  fallback: Cell | null | undefined,
): Cell | null | undefined {
  if (value === undefined) {
    return fallback
  }
  if (value === null) {
    return null
  }
  return parseBocCell(value, label)
}

function parseOptionalBigInt(
  value: bigint | string | undefined,
  label: string,
): bigint | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === "bigint") {
    return value
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  try {
    return BigInt(trimmed)
  } catch {
    throw new Error(`${label} must be an integer`)
  }
}

function parseOptionalUint(
  value: bigint | string | undefined,
  label: string,
  maximum?: bigint,
): bigint | undefined {
  const parsed = parseOptionalBigInt(value, label)
  if (parsed === undefined) {
    return undefined
  }
  if (parsed < 0n) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  if (maximum !== undefined && parsed > maximum) {
    throw new Error(`${label} is out of range`)
  }
  return parsed
}

function parseBocCell(value: string, label: string): Cell {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`)
  }

  try {
    return Cell.fromHex(trimmed.replace(/^0x/i, ""))
  } catch {
    try {
      return Cell.fromBase64(trimmed)
    } catch {
      throw new Error(`${label} must be a Cell BoC encoded as hex or base64`)
    }
  }
}

async function resolveEmulationMcSeqno(
  network: RetraceNetworkConfig,
  mcSeqno: number | undefined,
): Promise<number> {
  if (mcSeqno !== undefined) {
    if (!Number.isSafeInteger(mcSeqno) || mcSeqno < 0) {
      throw new Error("Masterchain block seqno must be a non-negative safe integer")
    }
    return mcSeqno
  }

  const response = await toncenterV2Get<GetMasterchainInfoResponse>(
    network,
    "getMasterchainInfo",
    {},
  )
  const latestSeqno = response.result?.last?.seqno
  if (typeof latestSeqno !== "number" || !Number.isSafeInteger(latestSeqno)) {
    throw new Error("getMasterchainInfo response is missing result.last.seqno")
  }

  return latestSeqno
}

async function loadRawMessageBlockContext(
  network: RetraceNetworkConfig,
  mcSeqno: number,
  options: EmulateRawMessageOptions,
): Promise<RawMessageBlockContext> {
  const blockConfig = await getBlockConfig(network, mcSeqno)
  const blocksResponse = await toncenterV3Get<{blocks: Block[]}>(network, "blocks", {
    workchain: -1,
    shard: "8000000000000000",
    seqno: mcSeqno,
  })
  const block = blocksResponse.blocks.at(0)
  if (!block) {
    throw new Error(`Cannot find masterchain block ${mcSeqno}`)
  }
  const previousBlocks = new Map<string, Promise<PrevBlocksInfo | undefined>>()
  const getCachedPrevBlocksInfo = async (with100: boolean): Promise<PrevBlocksInfo | undefined> => {
    if (mcSeqno <= 1) {
      return undefined
    }
    const key = with100 ? "full" : "short"
    let request = previousBlocks.get(key)
    if (!request) {
      request = getPrevBlocksInfo(network, mcSeqno, {with100})
      previousBlocks.set(key, request)
    }
    return request
  }

  return {
    mcSeqno,
    blockConfig,
    randSeed: blockRandSeed(block),
    now: rawMessageUnixTime(block, options.now),
    lt: rawMessageStartLt(block, options.lt),
    getPrevBlocksInfo: getCachedPrevBlocksInfo,
  }
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

function blockUnixTime(block: Block): number {
  const value = Number(block.gen_utime)
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error("Block gen_utime must be a valid uint32")
  }
  return value
}

function blockNextLt(block: Block): bigint {
  let value: bigint
  try {
    value = BigInt(block.end_lt)
  } catch {
    throw new Error("Block end_lt must be a non-negative integer")
  }
  if (value < 0n) {
    throw new Error("Block end_lt must be a non-negative integer")
  }
  return value + 1n
}

function rawMessageUnixTime(block: Block, override: number | undefined): number {
  const value = override ?? blockUnixTime(block)
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error("Message emulation time must be a valid uint32")
  }
  return value
}

function rawMessageStartLt(block: Block, override: bigint | undefined): bigint {
  const value = override ?? blockNextLt(block)
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT64) {
    throw new Error("Message emulation lt must be a valid uint64 bigint")
  }
  return value
}

function resolveRawMessageMaxTransactions(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_RAW_MESSAGE_MAX_TRANSACTIONS
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxTransactions must be a positive safe integer")
  }
  return value
}

function messageDestination(message: Message): Address | undefined {
  const destination = message.info.dest
  return Address.isAddress(destination) ? destination : undefined
}

async function loadRawMessageAccountState(
  network: RetraceNetworkConfig,
  mcSeqno: number,
  address: Address,
  accountStates: Map<string, RawMessageAccountState>,
): Promise<RawMessageAccountState> {
  const accountKey = address.toString()
  const cached = accountStates.get(accountKey)
  if (cached) {
    return cached
  }

  const shardAccount = await getShardAccountAtBlock(network, address, mcSeqno)
  const state = {
    shardAccountBase64: shardAccountToBase64(shardAccount),
    balance: shardAccount.account?.storage.balance.coins ?? 0n,
  }
  accountStates.set(accountKey, state)
  return state
}

function rawMessageBlockRef(blockContext: RawMessageBlockContext): BlockRef {
  return {
    workchain: -1,
    shard: "8000000000000000",
    seqno: blockContext.mcSeqno,
  }
}

function buildRawMessageToncenterTrace(
  rootHash: string,
  emulatedTransactions: readonly RawMessageEmulatedTransaction[],
  blockContext: RawMessageBlockContext,
): EmulatedTrace {
  const childrenByParent = new Map<string, RawMessageEmulatedTransaction[]>()
  for (const transaction of emulatedTransactions) {
    if (!transaction.parentHash) {
      continue
    }
    childrenByParent.set(transaction.parentHash, [
      ...(childrenByParent.get(transaction.parentHash) ?? []),
      transaction,
    ])
  }

  const childTransactionsByParent = new Map<string, string[]>()
  for (const [parentHash, children] of childrenByParent) {
    childTransactionsByParent.set(
      parentHash,
      children.map(child => child.transaction.lt.toString()),
    )
  }

  const transactions: Record<string, EmulatedTransaction> = Object.fromEntries(
    emulatedTransactions.map(transaction => [
      transaction.hash,
      rawMessageApiTransaction(
        transaction,
        blockContext,
        childTransactionsByParent.get(transaction.hash) ?? [],
        rootHash,
      ),
    ]),
  )
  const orderedHashes = emulatedTransactions.map(transaction => transaction.hash)
  const startLt = emulatedTransactions.at(0)?.transaction.lt ?? blockContext.lt
  const endLt = emulatedTransactions.at(-1)?.transaction.lt ?? startLt

  const rootTransaction = emulatedTransactions.at(0)
  const rootMessage = rootTransaction?.transaction.inMessage

  return {
    trace_id: rootHash,
    external_hash:
      rootMessage?.info.type === "external-in" ? (rootTransaction?.inMessageHash ?? null) : null,
    mc_seqno_start: blockContext.mcSeqno.toString(),
    mc_seqno_end: blockContext.mcSeqno.toString(),
    start_lt: startLt.toString(),
    start_utime: blockContext.now,
    end_lt: endLt.toString(),
    end_utime: blockContext.now,
    is_incomplete: false,
    trace: buildRawMessageTraceNode(rootHash, emulatedTransactions, childrenByParent),
    transactions,
    transactions_order: orderedHashes,
    trace_info: {
      transactions: emulatedTransactions.length,
      messages: emulatedTransactions.reduce(
        (sum, transaction) => sum + transaction.transaction.outMessagesCount,
        1,
      ),
      pending_messages: 0,
      trace_state: "complete",
      classification_state: "unavailable",
    },
  }
}

function buildRawMessageTraceNode(
  hash: string,
  emulatedTransactions: readonly RawMessageEmulatedTransaction[],
  childrenByParent: ReadonlyMap<string, readonly RawMessageEmulatedTransaction[]>,
): EmulatedTrace["trace"] {
  const transaction = emulatedTransactions.find(item => item.hash === hash)
  return {
    tx_hash: hash,
    in_msg_hash: transaction?.inMessageHash,
    in_msg: transaction?.transaction.inMessage
      ? rawMessageApiMessage(transaction.transaction.inMessage, transaction.inMessageCell)
      : null,
    children: (childrenByParent.get(hash) ?? []).map(child =>
      buildRawMessageTraceNode(child.hash, emulatedTransactions, childrenByParent),
    ),
  }
}

function rawMessageApiTransaction(
  item: RawMessageEmulatedTransaction,
  blockContext: RawMessageBlockContext,
  childTransactions: readonly string[] = [],
  traceId: string = item.hash,
): EmulatedTransaction {
  const transaction = item.transaction
  return {
    account: item.address.toRawString(),
    hash: item.hash,
    lt: transaction.lt.toString(),
    now: transaction.now,
    mc_block_seqno: blockContext.mcSeqno,
    trace_id: traceId,
    prev_trans_hash: uint256Hex(transaction.prevTransactionHash),
    prev_trans_lt: transaction.prevTransactionLt.toString(),
    orig_status: accountStatusToApi(transaction.oldStatus),
    end_status: accountStatusToApi(transaction.endStatus),
    total_fees: transaction.totalFees.coins.toString(),
    total_fees_extra_currencies: extraCurrenciesToApi(transaction.totalFees.other),
    description: transactionDescriptionToApi(transaction.description),
    block_ref: rawMessageBlockRef(blockContext),
    in_msg: transaction.inMessage
      ? rawMessageApiMessage(transaction.inMessage, item.inMessageCell)
      : null,
    out_msgs: [...transaction.outMessages].map(([index, message]) => {
      const messageCell = item.outMessageCells.get(index)
      if (!messageCell) {
        throw new Error(`Cannot extract raw outgoing message ${index}`)
      }
      return rawMessageApiMessage(message, messageCell)
    }),
    account_state_before: shardAccountToApiState(item.shardAccountBefore),
    account_state_after: shardAccountToApiState(item.shardAccountAfter),
    child_transactions: childTransactions,
    emulated: true,
  }
}

function rawMessageApiMessage(message: Message, messageCell: Cell): EmulatedMessage {
  const body = message.body
  const initCell = message.init ? beginCell().store(storeStateInit(message.init)).endCell() : null
  const opcode = messageOpcode(message)
  const common = {
    hash: messageCell.hash().toString("hex"),
    opcode: opcode ?? null,
    message_content: {
      hash: body.hash().toString("hex"),
      body: body.toBoc().toString("base64"),
      decoded: null,
    },
    init_state: initCell
      ? {
          hash: initCell.hash().toString("hex"),
          body: initCell.toBoc().toString("base64"),
        }
      : null,
  }

  if (message.info.type === "internal") {
    return {
      ...common,
      source: message.info.src.toRawString(),
      destination: message.info.dest.toRawString(),
      value: message.info.value.coins.toString(),
      value_extra_currencies: extraCurrenciesToApi(message.info.value.other),
      fwd_fee: message.info.forwardFee.toString(),
      ihr_fee: "0",
      extra_flags: message.info.ihrFee.toString(),
      import_fee: null,
      created_lt: message.info.createdLt.toString(),
      created_at: message.info.createdAt.toString(),
      ihr_disabled: message.info.ihrDisabled,
      bounce: message.info.bounce,
      bounced: message.info.bounced,
    }
  }

  if (message.info.type === "external-in") {
    return {
      ...common,
      source: null,
      destination: message.info.dest.toRawString(),
      value: null,
      value_extra_currencies: {},
      fwd_fee: null,
      ihr_fee: null,
      extra_flags: null,
      import_fee: message.info.importFee.toString(),
      created_lt: null,
      created_at: null,
      ihr_disabled: null,
      bounce: null,
      bounced: null,
    }
  }

  return {
    ...common,
    source: message.info.src.toRawString(),
    destination: null,
    value: null,
    value_extra_currencies: {},
    fwd_fee: null,
    ihr_fee: null,
    extra_flags: null,
    import_fee: null,
    created_lt: message.info.createdLt.toString(),
    created_at: message.info.createdAt.toString(),
    ihr_disabled: null,
    bounce: null,
    bounced: null,
  }
}

function shardAccountToApiState(shardAccountBase64: string): EmulatedAccountState {
  const cell = Cell.fromBase64(shardAccountBase64)
  const shardAccount = loadShardAccount(cell.asSlice())
  const account = shardAccount.account
  const storageState = account?.storage.state
  const activeState = storageState?.type === "active" ? storageState.state : undefined
  const code = activeState?.code ?? undefined
  const data = activeState?.data ?? undefined

  return {
    hash: cell.hash().toString("hex"),
    balance: account?.storage.balance.coins.toString() ?? null,
    code_boc: code?.toBoc().toString("base64") ?? null,
    extra_currencies: extraCurrenciesToApi(account?.storage.balance.other),
    account_status: shardAccountStatusToApi(shardAccount),
    data_boc: data?.toBoc().toString("base64") ?? null,
    frozen_hash: storageState?.type === "frozen" ? hashLikeToHex(storageState.stateHash) : null,
    data_hash: data?.hash().toString("hex") ?? null,
    code_hash: code?.hash().toString("hex") ?? null,
  }
}

function transactionDescriptionToApi(description: Transaction["description"]): EmulatedDescription {
  if (description.type === "tick-tock") {
    return {
      type: "tick_tock",
      aborted: description.aborted,
      destroyed: description.destroyed,
      is_tock: description.isTock,
      storage_ph: storagePhaseToApi(description.storagePhase),
      compute_ph: computePhaseToApi(description.computePhase),
      action: actionPhaseToApi(description.actionPhase),
    }
  }

  if (description.type !== "generic") {
    return {
      type: description.type,
      aborted: false,
      destroyed: false,
      compute_ph: {
        skipped: true,
        reason: "unsupported",
      },
    }
  }

  return {
    type: "ord",
    aborted: description.aborted,
    destroyed: description.destroyed,
    credit_first: description.creditFirst,
    storage_ph: storagePhaseToApi(description.storagePhase),
    credit_ph: creditPhaseToApi(description.creditPhase),
    compute_ph: computePhaseToApi(description.computePhase),
    action: actionPhaseToApi(description.actionPhase),
    bounce: bouncePhaseToApi(description.bouncePhase),
  }
}

function creditPhaseToApi(
  phase: Extract<Transaction["description"], {type: "generic"}>["creditPhase"],
): Description["credit_ph"] {
  if (!phase) {
    return undefined
  }

  return {
    credit: phase.credit.coins.toString(),
    credit_extra_currencies: extraCurrenciesToApi(phase.credit.other),
    due_fees_collected: phase.dueFeesColelcted?.toString(),
  }
}

function bouncePhaseToApi(
  phase: Extract<Transaction["description"], {type: "generic"}>["bouncePhase"],
): Description["bounce"] {
  if (!phase) {
    return undefined
  }

  if (phase.type === "negative-funds") {
    return {type: "negfunds"}
  }

  const messageSize = {
    cells: phase.messageSize.cells.toString(),
    bits: phase.messageSize.bits.toString(),
  }
  if (phase.type === "no-funds") {
    return {
      type: "nofunds",
      msg_size: messageSize,
      req_fwd_fees: phase.requiredForwardFees.toString(),
    }
  }

  return {
    type: phase.type,
    msg_size: messageSize,
    msg_fees: phase.messageFees.toString(),
    fwd_fees: phase.forwardFees.toString(),
  }
}

function storagePhaseToApi(
  phase:
    | {
        storageFeesCollected: bigint
        storageFeesDue?: bigint | null
        statusChange: string
      }
    | null
    | undefined,
): Description["storage_ph"] {
  if (!phase) {
    return undefined
  }

  return {
    storage_fees_collected: phase.storageFeesCollected.toString(),
    storage_fees_due: phase.storageFeesDue?.toString(),
    status_change: phase.statusChange,
  }
}

function computePhaseToApi(
  phase: Extract<Transaction["description"], {type: "generic" | "tick-tock"}>["computePhase"],
): NonNullable<EmulatedDescription["compute_ph"]> {
  if (phase.type === "skipped") {
    return {
      skipped: true,
      reason: phase.reason.replace("-", "_"),
    }
  }

  return {
    skipped: false,
    success: phase.success,
    msg_state_used: phase.messageStateUsed,
    account_activated: phase.accountActivated,
    gas_fees: phase.gasFees.toString(),
    gas_used: phase.gasUsed.toString(),
    gas_limit: phase.gasLimit.toString(),
    gas_credit: phase.gasCredit?.toString(),
    mode: phase.mode,
    exit_code: phase.exitCode,
    exit_arg: phase.exitArg ?? undefined,
    vm_steps: phase.vmSteps,
    vm_init_state_hash: uint256Hex(phase.vmInitStateHash),
    vm_final_state_hash: uint256Hex(phase.vmFinalStateHash),
  }
}

function actionPhaseToApi(
  phase: Extract<Transaction["description"], {type: "generic" | "tick-tock"}>["actionPhase"],
): Description["action"] {
  if (!phase) {
    return undefined
  }

  return {
    success: phase.success,
    valid: phase.valid,
    no_funds: phase.noFunds,
    status_change: phase.statusChange,
    result_code: phase.resultCode,
    result_arg: phase.resultArg ?? undefined,
    tot_actions: phase.totalActions,
    spec_actions: phase.specActions,
    skipped_actions: phase.skippedActions,
    msgs_created: phase.messagesCreated,
    total_fwd_fees: phase.totalFwdFees?.toString(),
    total_action_fees: phase.totalActionFees?.toString(),
    action_list_hash: uint256Hex(phase.actionListHash),
    tot_msg_size: {
      cells: phase.totalMessageSize.cells.toString(),
      bits: phase.totalMessageSize.bits.toString(),
    },
  }
}

function extraCurrenciesToApi(
  currencies: Iterable<readonly [number, bigint]> | null | undefined,
): Record<string, string> {
  return currencies
    ? Object.fromEntries([...currencies].map(([id, amount]) => [id.toString(), amount.toString()]))
    : {}
}

function shardAccountStatusToApi(shardAccount: ShardAccount): string {
  const state = shardAccount.account?.storage.state
  return state?.type ?? "nonexist"
}

function accountStatusToApi(status: Transaction["oldStatus"]): string {
  if (status === "uninitialized") {
    return "uninit"
  }
  if (status === "non-existing") {
    return "nonexist"
  }
  return status
}

function messageOpcode(message: Message): number | undefined {
  const isBounced = message.info.type === "internal" ? message.info.bounced : false
  const slice = message.body.asSlice()
  if (isBounced) {
    if (slice.remainingBits < 32) {
      return undefined
    }
    slice.loadUint(32)
  }
  return slice.remainingBits >= 32 ? slice.loadUint(32) : undefined
}

function uint256Hex(value: bigint | undefined): string {
  return (value ?? 0n).toString(16).padStart(64, "0")
}

function hashLikeToHex(value: bigint | Buffer | undefined): string | null {
  if (value === undefined) {
    return null
  }
  return typeof value === "bigint" ? uint256Hex(value) : value.toString("hex")
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
