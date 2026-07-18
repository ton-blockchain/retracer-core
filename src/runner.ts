import {
    Block,
    BlockRef,
    EmulateRawMessageResult,
    EmulateRawMessageOptions,
    RawTransaction,
    RetraceNetworkConfig,
    RetraceOptions,
    Trace,
    TraceData,
    TraceReplayResult,
    TraceResult,
    Transaction as ToncenterTransaction,
} from "./types"
import {
    BaseTxInfo,
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
    getShardAccountAtBlock,
    prepareEmulator,
    shardAccountToBase64,
} from "./methods"
import {Buffer} from "buffer"
import {
    Address,
    beginCell,
    Cell,
    type AccountState,
    type Message,
    loadMessage,
    loadShardAccount,
    loadTransaction,
    type ShardAccount,
    storeMessage,
    storeShardAccount,
    storeStateInit,
    storeTransaction,
    Transaction,
} from "@ton/core"
import {EmulationResultSuccess, PrevBlocksInfo} from "@ton/sandbox/dist/executor/Executor"
import {logs} from "ton-assembly"
import {buildSourceTraceForTraceResult} from "./sourceTrace"
import {toncenterHashToBuffer, toncenterV2Get, toncenterV3Get} from "./networks"

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
 * @throws Error   If any network lookup fails; if the corresponding shard‑ /
 *                 master‑block cannot be found; if deterministic replay
 *                 diverges (TVM returns non‑success); or if state‑hash
 *                 mismatch is detected after replay.
 */
export const retrace = async (
    network: RetraceNetworkConfig,
    txLink: string,
    options: RetraceOptions = {},
): Promise<TraceResult> => {
    const additionalLibs = options.additionalLibs ?? []
    const baseTx = await findBaseTxByHash(network, txLink)
    if (baseTx === undefined) {
        throw new Error("Cannot find transaction info")
    }
    const result = await retraceBaseTx(network, baseTx, additionalLibs, options.sourceMap)
    if (result.emulatedTx.computeInfo === "skipped") {
        return result
    }

    if (result.emulatedTx.computeInfo.exitCode === 0) {
        // fast path
        return result
    }

    if (result.emulatedTx.computeInfo.exitCode === 9) {
        // This can be both a simple cell underflow and failed to load a library cell.
        // Parse vmLogs to find out.

        // Example logs:
        //
        // stack: [ ... C{B5EE9C72010101010023000842029468B29F43AC803FC9F621953FDD069A432E4CD1D9A56B9C299B587FE6898FAB} ]
        // code cell hash: 4F5F4CE417F91358B532A9670A09D20AC7E01850E9B704A4DF1CC5373EE6EDE4 offset: 887
        // execute CTOS
        // handling exception code 9: failed to load library cell
        // default exception handler, terminating vm with exit code 9

        const lines = logs.parse(result.emulatedTx.vmLogs)

        const exceptionHandlerLine = lines.at(-2)
        const exceptionLine = lines.at(-3)
        const ctosLine = lines.at(-4)
        const stackLine = lines.at(-6)
        if (
            exceptionHandlerLine?.$ === "VmExceptionHandler" &&
            exceptionLine?.$ === "VmException" &&
            exceptionLine.message === "failed to load library cell" &&
            ctosLine?.$ === "VmExecute" &&
            ctosLine.instr === "CTOS" &&
            stackLine?.$ === "VmStack"
        ) {
            // So we find out that the transaction failed to load a library cell.
            // Stack before CTOS will contain the library cell as the top element.
            const topElement = stackLine.stack.at(-1)
            if (topElement?.$ === "Cell") {
                const libraryResult = await tryLoadAsLibrary(topElement.boc, network)
                if (libraryResult === undefined) {
                    // Either the library cell is not an exotic library cell, or we cannot load it.
                    return result
                }

                // Now we have the library content and hash, so we try again with this library.
                const {libHashHex, actualCode} = libraryResult
                const additionalLib: [bigint, Cell] = [BigInt(`0x${libHashHex}`), actualCode]
                return retrace(network, txLink, {
                    additionalLibs: [...additionalLibs, additionalLib],
                    sourceMap: options.sourceMap,
                })
            }
        }
    }

    return result
}

interface TraceReplayTransaction {
    hash: string
    apiTransaction: ToncenterTransaction
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

const DEFAULT_RAW_MESSAGE_MAX_TRANSACTIONS = 128

export const retraceTrace = async (
    network: RetraceNetworkConfig,
    txHash: string,
    options: RetraceOptions = {},
): Promise<TraceReplayResult> => {
    const trace = await loadTraceByTransactionHash(network, txHash)
    const traceTransactions = orderedTraceTransactions(trace)
    if (traceTransactions.length === 0) {
        throw new Error("Trace does not contain transactions")
    }

    const dynamicLibs = [...(options.additionalLibs ?? [])]
    const loadedDynamicLibraries = new Set(dynamicLibs.map(([hash]) => hash.toString(16)))

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const caches: TraceReplayCaches = {
            rawTransactions: new Map(),
            blockContexts: new Map(),
            accountStates: new Map(),
        }
        const results: Record<string, TraceResult> = {}
        let missingLibrary: [bigint, Cell] | undefined

        for (const traceTransaction of traceTransactions) {
            const result = await replayTraceTransaction(network, traceTransaction, dynamicLibs, {
                sourceMap: options.sourceMap,
                caches,
            })
            results[traceTransaction.hash] = result

            const library = await tryLoadMissingLibraryFromResult(result, network)
            if (library) {
                const [hash] = library
                const hashKey = hash.toString(16)
                if (!loadedDynamicLibraries.has(hashKey)) {
                    missingLibrary = library
                    loadedDynamicLibraries.add(hashKey)
                    break
                }
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

    throw new Error("Trace replay failed to recover missing libraries")
}

export const emulateRawMessage = async (
    network: RetraceNetworkConfig,
    rawMessage: Cell | string,
    options: EmulateRawMessageOptions = {},
): Promise<EmulateRawMessageResult> => {
    const messageCell = rawMessage instanceof Cell ? rawMessage : parseRawMessageCell(rawMessage)
    const dynamicLibs = [...(options.additionalLibs ?? [])]
    const loadedDynamicLibraries = new Set(dynamicLibs.map(([hash]) => hash.toString(16)))

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await emulateRawMessageCascade(network, messageCell, {
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
            if (!loadedDynamicLibraries.has(hashKey)) {
                missingLibrary = library
                loadedDynamicLibraries.add(hashKey)
                break
            }
        }

        if (missingLibrary) {
            dynamicLibs.push(missingLibrary)
            continue
        }

        return result
    }

    throw new Error("Raw message emulation failed to recover missing libraries")
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
    traceResult: TraceResult
    shardAccountBefore: string
    shardAccountAfter: string
}

async function emulateRawMessageCascade(
    network: RetraceNetworkConfig,
    messageCell: Cell,
    options: EmulateRawMessageOptions,
): Promise<EmulateRawMessageResult> {
    const message = loadMessage(messageCell.asSlice())
    const destination = message.info.dest
    if (!Address.isAddress(destination)) {
        throw new Error("Raw message destination must be an account address")
    }

    const mcSeqno = await resolveEmulationMcSeqno(network, options.mcSeqno)
    const blockContext = await loadRawMessageBlockContext(network, mcSeqno, options)
    const maxTransactions = resolveRawMessageMaxTransactions(options.maxTransactions)
    const accountStates = await buildRawMessageAccountStateOverrides(
        network,
        mcSeqno,
        options.accountStateOverrides,
    )
    const queue: RawMessageQueueItem[] = [{message, messageCell}]
    const emulatedTransactions: RawMessageEmulatedTransaction[] = []

    while (queue.length > 0) {
        if (emulatedTransactions.length >= maxTransactions) {
            throw new Error(`Raw message emulation exceeded ${maxTransactions} transactions`)
        }

        const item = queue.shift()
        if (item === undefined) {
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
            {ignoreChksig: options.ignoreChksig},
        )
        const txLt = blockContext.lt + BigInt(emulatedTransactions.length)
        const txRes = await emulateMessage(
            item.messageCell,
            accountState.shardAccountBase64,
            blockContext.now,
            txLt,
        )
        if (!txRes.result.success) {
            throw new Error(`Message emulation failed: ${txRes.result.error}`)
        }

        const emulatedTx = loadTransaction(Cell.fromBase64(txRes.result.transaction).asSlice())
        const hash = transactionHashHex(emulatedTx)
        const emulation: TraceReplayEmulation = {
            emulatorVersion,
            logs: txRes.logs,
            result: txRes.result,
            prevBalance: accountState.balance,
            shardAccountBeforeTargetBase64: accountState.shardAccountBase64,
            stateUpdateHashOk: true,
        }
        const baseTx: BaseTxInfo = {
            lt: emulatedTx.lt,
            hash: Buffer.from(hash, "hex"),
            address: txDestination,
            block: rawMessageBlockRef(blockContext),
        }
        const traceResult = await buildTraceResult({
            baseTx,
            tx: emulatedTx,
            emulation,
            loadedCode,
            codeCell,
            sourceMap: options.sourceMap,
        })

        accountStates.set(txDestination.toString(), {
            shardAccountBase64: txRes.result.shardAccount,
            balance:
                loadShardAccount(Cell.fromBase64(txRes.result.shardAccount).asSlice()).account
                    ?.storage.balance.coins ?? 0n,
        })

        emulatedTransactions.push({
            hash,
            parentHash: item.parentHash,
            inMessageHash: messageHashHex(item.message),
            address: txDestination,
            transaction: emulatedTx,
            traceResult,
            shardAccountBefore: accountState.shardAccountBase64,
            shardAccountAfter: txRes.result.shardAccount,
        })

        for (const outMessage of emulatedTx.outMessages.values()) {
            const outDestination = messageDestination(outMessage)
            if (!outDestination) {
                continue
            }

            queue.push({
                message: outMessage,
                messageCell: beginCell().store(storeMessage(outMessage)).endCell(),
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
            emulatedTransactions.map(tx => [tx.hash, tx.traceResult] as const),
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

    // on fetch failure (e.g. genesis blocks are not available via API)
    // emulate without prev_blocks_info, as before
    const fetchPrevBlocksInfo = async (with100: boolean): Promise<PrevBlocksInfo | undefined> => {
        if (mcSeqno <= 1) {
            return undefined
        }

        return getPrevBlocksInfo(network, mcSeqno, {with100}).catch((error: unknown) => {
            console.error("Cannot get prev blocks info", error)
            return undefined
        })
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
    const pushHash = (hash: string | undefined): void => {
        if (hash === undefined || hash.length === 0) return
        const normalized = normalizeTraceHash(hash)
        if (!orderedHashes.includes(normalized)) {
            orderedHashes.push(normalized)
        }
    }

    const visitNode = (node: TraceData["traces"][number]["trace"] | undefined): void => {
        if (!node) return
        pushHash(node.tx_hash)
        for (const child of node.children ?? []) {
            visitNode(child)
        }
    }

    visitNode(trace.trace)
    for (const hash of trace.transactions_order) {
        pushHash(hash)
    }
    for (const transaction of Object.values(trace.transactions).sort(compareApiTransactionLt)) {
        pushHash(transaction.hash)
    }

    return orderedHashes.flatMap(hash => {
        const transaction = transactionsByHash.get(hash)
        if (!transaction) {
            return []
        }
        return [
            {
                hash,
                apiTransaction: transaction,
                baseTx: baseTxFromTraceTransaction(transaction),
            },
        ]
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

    const shardAccountAfter = loadShardAccount(
        Cell.fromBase64(result.account.shardAccountAfter).asSlice(),
    )
    options.caches.accountStates.set(accountKey, {
        blockKey: blockContext.blockKey,
        lt: replayRange.targetTx.lt,
        balance: shardAccountAfter.account?.storage.balance.coins ?? 0n,
        shardAccountBase64: result.account.shardAccountAfter,
    })

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
    const transactions = await findAllTransactionsBetween(
        network,
        baseTx,
        cachedAccountState.lt + 1n,
    )
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

    const shardAccountBeforeTx = await getBlockAccount(
        network,
        baseTx.address,
        blockContext.mcSeqno,
    )
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
    const randSeed = Buffer.from(block.rand_seed, "base64")
    const prevBlocksInfo: Map<string, Promise<PrevBlocksInfo | undefined>> = new Map()
    const getCachedPrevBlocksInfo = async (
        with100: boolean,
    ): Promise<PrevBlocksInfo | undefined> => {
        if (mcSeqno <= 1) {
            return undefined
        }
        const key = with100 ? "full" : "short"
        let request = prevBlocksInfo.get(key)
        if (!request) {
            request = getPrevBlocksInfo(network, mcSeqno, {with100}).catch((error: unknown) => {
                console.error("Cannot get prev blocks info", error)
                return undefined
            })
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
    const accountStates: Map<string, RawMessageAccountState> = new Map()

    for (const [addressString, override] of Object.entries(overrides)) {
        const address = Address.parse(addressString)
        const shardAccountBoc = override.shardAccountBoc?.trim()
        const baseShardAccount =
            shardAccountBoc !== undefined && shardAccountBoc.length > 0
            ? loadShardAccount(
                  parseBocCell(shardAccountBoc, "Account state override").asSlice(),
              )
            : await getShardAccountAtBlock(network, address, mcSeqno)
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
    const lastTransactionLt = parseOptionalBigInt(override.lastTransactionLt, "lastTransactionLt")
    const lastTransactionHash = parseOptionalBigInt(
        override.lastTransactionHash,
        "lastTransactionHash",
    )
    const storageLastTransactionLt =
        parseOptionalBigInt(override.storageLastTransactionLt, "storageLastTransactionLt") ??
        lastTransactionLt

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
        const balance = parseOptionalBigInt(override.balance, "balance")
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
    baseState: AccountState,
    override: NonNullable<EmulateRawMessageOptions["accountStateOverrides"]>[string]["state"],
): AccountState {
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
                parseOptionalBigInt(override.stateHash, "stateHash") ??
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

function parseBocCell(value: string, label: string): Cell {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
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
    const prevBlocksInfo: Map<string, Promise<PrevBlocksInfo | undefined>> = new Map()
    const getCachedPrevBlocksInfo = async (
        with100: boolean,
    ): Promise<PrevBlocksInfo | undefined> => {
        if (mcSeqno <= 1) {
            return undefined
        }
        const key = with100 ? "full" : "short"
        let request = prevBlocksInfo.get(key)
        if (!request) {
            request = getPrevBlocksInfo(network, mcSeqno, {with100}).catch((error: unknown) => {
                console.error("Cannot get prev blocks info", error)
                return undefined
            })
            prevBlocksInfo.set(key, request)
        }
        return request
    }

    return {
        mcSeqno,
        blockConfig,
        randSeed: blockRandSeed(block),
        now: options.now ?? blockUnixTime(block),
        lt: options.lt ?? blockNextLt(block),
        getPrevBlocksInfo: getCachedPrevBlocksInfo,
    }
}

function blockRandSeed(block: Block): Buffer {
    const value = block.rand_seed.trim()
    if (!value) {
        return Buffer.alloc(32)
    }
    const buffer = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    return buffer.length === 32 ? buffer : Buffer.alloc(32)
}

function blockUnixTime(block: Block): number {
    const value = Number(block.gen_utime)
    return Number.isFinite(value) ? value : Math.floor(Date.now() / 1000)
}

function blockNextLt(block: Block): bigint {
    try {
        return BigInt(block.end_lt) + 1n
    } catch {
        return 0n
    }
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
): Trace {
    const childrenByParent: Map<string, RawMessageEmulatedTransaction[]> = new Map()
    for (const tx of emulatedTransactions) {
        if (tx.parentHash === undefined) {
            continue
        }
        childrenByParent.set(tx.parentHash, [...(childrenByParent.get(tx.parentHash) ?? []), tx])
    }

    const childLtsByParent: Map<string, string[]> = new Map()
    for (const [parentHash, children] of childrenByParent) {
        childLtsByParent.set(
            parentHash,
            children.map(child => child.transaction.lt.toString()),
        )
    }

    const transactions: Record<string, ToncenterTransaction> = Object.fromEntries(
        emulatedTransactions.map(tx => {
            return [
                tx.hash,
                rawMessageApiTransaction(
                    tx,
                    blockContext,
                    childLtsByParent.get(tx.hash) ?? [],
                    rootHash,
                ),
            ] as const
        }),
    )
    const orderedHashes = emulatedTransactions.map(tx => tx.hash)
    const startLt = emulatedTransactions.at(0)?.transaction.lt ?? blockContext.lt
    const endLt = emulatedTransactions.at(-1)?.transaction.lt ?? startLt

    return {
        trace_id: rootHash,
        external_hash: emulatedTransactions.at(0)?.inMessageHash ?? null,
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
                (sum, tx) => sum + tx.transaction.outMessagesCount,
                emulatedTransactions.length,
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
): Trace["trace"] {
    const tx = emulatedTransactions.find(item => item.hash === hash)
    return {
        tx_hash: hash,
        in_msg_hash: tx?.inMessageHash,
        in_msg: tx?.transaction.inMessage ? rawMessageApiMessage(tx.transaction.inMessage) : null,
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
): ToncenterTransaction {
    const tx = item.transaction
    return {
        account: item.address.toRawString(),
        hash: item.hash,
        lt: tx.lt.toString(),
        now: tx.now,
        mc_block_seqno: blockContext.mcSeqno,
        trace_id: traceId,
        prev_trans_hash: uint256Hex(tx.prevTransactionHash),
        prev_trans_lt: tx.prevTransactionLt.toString(),
        orig_status: accountStatusToApi(tx.oldStatus),
        end_status: accountStatusToApi(tx.endStatus),
        total_fees: tx.totalFees.coins.toString(),
        total_fees_extra_currencies: {},
        description: transactionDescriptionToApi(tx.description),
        block_ref: rawMessageBlockRef(blockContext),
        in_msg: tx.inMessage ? rawMessageApiMessage(tx.inMessage) : null,
        out_msgs: [...tx.outMessages.values()].map(message => rawMessageApiMessage(message)),
        account_state_before: shardAccountToApiState(item.shardAccountBefore),
        account_state_after: shardAccountToApiState(item.shardAccountAfter),
        child_transactions: childTransactions,
        emulated: true,
    }
}

function rawMessageApiMessage(message: Message) {
    const body = message.body
    const initCell = message.init ? beginCell().store(storeStateInit(message.init)).endCell() : null
    const opcode = messageOpcode(message)
    const common = {
        hash: messageHashHex(message),
        opcode: opcode ?? null,
        message_content: {
            hash: body.hash().toString("hex"),
            body: body.toBoc().toString("base64"),
            decoded: {},
        },
        init_state: initCell
            ? {
                  hash: initCell.hash().toString("hex"),
                  body: initCell.toBoc().toString("base64"),
              }
            : undefined,
    }

    if (message.info.type === "internal") {
        return {
            ...common,
            source: message.info.src.toString(),
            destination: message.info.dest.toString(),
            value: message.info.value.coins.toString(),
            fwd_fee: message.info.forwardFee.toString(),
            ihr_fee: message.info.ihrFee.toString(),
            import_fee: "0",
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
            source: undefined,
            destination: message.info.dest.toString(),
            value: "0",
            fwd_fee: "0",
            ihr_fee: "0",
            import_fee: message.info.importFee.toString(),
            created_lt: "0",
            created_at: "0",
            ihr_disabled: true,
            bounce: false,
            bounced: false,
        }
    }

    return {
        ...common,
        source: message.info.src.toString(),
        destination: undefined,
        value: "0",
        fwd_fee: "0",
        ihr_fee: "0",
        import_fee: "0",
        created_lt: message.info.createdLt.toString(),
        created_at: message.info.createdAt.toString(),
        ihr_disabled: true,
        bounce: false,
        bounced: false,
    }
}

function shardAccountToApiState(shardAccountBase64: string) {
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
        extra_currencies: {},
        account_status: shardAccountStatusToApi(shardAccount),
        data_boc: data?.toBoc().toString("base64") ?? null,
        frozen_hash: storageState?.type === "frozen" ? hashLikeToHex(storageState.stateHash) : null,
        data_hash: data?.hash().toString("hex") ?? null,
        code_hash: code?.hash().toString("hex") ?? null,
    }
}

function transactionDescriptionToApi(description: Transaction["description"]) {
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
                success: false,
                exit_code: 0,
            },
            action: actionPhaseToApi(undefined),
        }
    }

    return {
        type: "generic",
        aborted: description.aborted,
        destroyed: description.destroyed,
        credit_first: description.creditFirst,
        storage_ph: storagePhaseToApi(description.storagePhase),
        compute_ph: computePhaseToApi(description.computePhase),
        action: actionPhaseToApi(description.actionPhase),
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
) {
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
    phase:
        | {
              type: "skipped"
              reason: string
          }
        | {
              type: "vm"
              success: boolean
              messageStateUsed: boolean
              accountActivated: boolean
              gasFees: bigint
              gasUsed: bigint
              gasLimit: bigint
              gasCredit?: bigint | null
              mode: number
              exitCode: number
              exitArg?: number | null
              vmSteps: number
              vmInitStateHash: bigint
              vmFinalStateHash: bigint
          },
) {
    if (phase.type === "skipped") {
        return {
            skipped: true,
            reason: phase.reason,
            success: false,
            exit_code: 0,
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
    phase:
        | {
              success: boolean
              valid: boolean
              noFunds: boolean
              statusChange: string
              resultCode: number
              resultArg?: number | null
              totalActions: number
              specActions: number
              skippedActions: number
              messagesCreated: number
              totalFwdFees?: bigint | null
              totalActionFees?: bigint | null
              actionListHash: bigint
              totalMessageSize: {
                  cells: bigint
                  bits: bigint
              }
          }
        | null
        | undefined,
) {
    if (!phase) {
        return {
            success: true,
            valid: true,
            no_funds: false,
            status_change: "unchanged",
            result_code: 0,
            tot_actions: 0,
            spec_actions: 0,
            skipped_actions: 0,
            msgs_created: 0,
            action_list_hash: uint256Hex(0n),
            tot_msg_size: {
                cells: "0",
                bits: "0",
            },
        }
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

function accountStatusToApi(status: Transaction["oldStatus"]): string {
    return status
}

function shardAccountStatusToApi(shardAccount: ShardAccount): string {
    const state = shardAccount.account?.storage.state
    if (!state) {
        return "non-existing"
    }
    return state.type
}

function transactionHashHex(tx: Transaction): string {
    return beginCell().store(storeTransaction(tx)).endCell().hash().toString("hex")
}

function messageHashHex(message: Message): string {
    return beginCell().store(storeMessage(message)).endCell().hash().toString("hex")
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
    if (typeof value === "bigint") {
        return uint256Hex(value)
    }
    return value.toString("hex")
}

async function tryLoadMissingLibraryFromResult(
    result: TraceResult,
    network: RetraceNetworkConfig,
): Promise<[bigint, Cell] | undefined> {
    if (
        result.emulatedTx.computeInfo === "skipped" ||
        result.emulatedTx.computeInfo.exitCode !== 9
    ) {
        return undefined
    }

    const lines = logs.parse(result.emulatedTx.vmLogs)
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

    let opcode: number | undefined = undefined
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
