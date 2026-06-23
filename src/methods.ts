import {
    Address,
    beginCell,
    Cell,
    Dictionary,
    loadOutList,
    loadShardAccount,
    loadTransaction,
    ShardAccount,
    storeMessage,
    storeShardAccount,
    Transaction,
} from "@ton/core"
import {
    Block,
    BlockRef,
    BlocksResponse,
    ComputeInfo,
    RawTransaction,
    RetraceNetworkConfig,
    TraceMoneyResult,
    TransactionData,
} from "./types"
import {
    BlockId,
    EmulationResult,
    EmulationResultSuccess,
    Executor,
    PrevBlocksInfo,
    TickOrTock,
} from "@ton/sandbox/dist/executor/Executor"
import {runtime} from "ton-assembly"
import {
    toncenterAddressParam,
    toncenterHashToBuffer,
    toncenterV2Get,
    toncenterV2JsonRpc,
    toncenterV3Get,
    toncenterV3HashParam,
    toncenterV3ShardParam,
} from "./networks"

/**
 * Minimal “handle” for locating a transaction on the TON blockchain.
 * A tuple of (lt, hash, address) is guaranteed to be unique and can be
 * passed to RPC methods such as `getTransactions` to retrieve
 * the full on‑chain record.
 *
 * Can be obtained by {@link findBaseTxByHash}.
 */
export interface BaseTxInfo {
    /**
     * Logical‑time of the transaction.
     */
    lt: bigint
    /**
     * Raw 256‑bit hash of the transaction BoC.
     */
    hash: Buffer
    /**
     * Contract address that issued / owns the transaction.
     */
    address: Address
    /**
     * Shard block reference returned by Toncenter v3 for this transaction.
     */
    block: BlockRef
}

/**
 * Returns base transaction information by its hash using Toncenter v3.
 * @param network Toncenter-compatible network configuration.
 * @param txHash  Transaction hash to find.
 */
export const findBaseTxByHash = async (
    network: RetraceNetworkConfig,
    txHash: string,
): Promise<BaseTxInfo | undefined> => {
    const requestedHash = toncenterHashToBuffer(txHash)
    const transactionInfo = await toncenterV3Get<TransactionData>(network, "transactions", {
        hash: toncenterV3HashParam(requestedHash),
        limit: 1,
    })

    const rawTx = transactionInfo.transactions.at(0)
    if (rawTx === undefined) {
        return undefined
    }

    const lt = BigInt(rawTx.lt)
    const hash = toncenterHashToBuffer(rawTx.hash)
    if (!hash.equals(requestedHash)) {
        return undefined
    }
    const address = Address.parseRaw(rawTx.account)
    const block = rawTx.block_ref

    return {lt, hash, address, block}
}

/**
 * Returns raw transaction BoC from Toncenter v2 and pairs it with the
 * Toncenter v3 block reference captured by {@link findBaseTxByHash}.
 *
 * Toncenter v2 `getTransactions` returns the raw transaction cell but not the
 * v4-style block envelope. The block reference is therefore carried in
 * {@link BaseTxInfo} from the v3 transaction lookup.
 *
 * @param network Toncenter-compatible network configuration.
 * @param info    Base transaction information for search.
 */
export const findRawTxByHash = async (
    network: RetraceNetworkConfig,
    info: BaseTxInfo,
): Promise<RawTransaction> => {
    const {lt, hash, address, block} = info
    const response = await toncenterV2JsonRpc<GetTransactionsResponse>(network, "getTransactions", {
        address: toncenterAddressParam(network, address),
        lt: lt.toString(),
        hash: hash.toString("base64"),
        limit: 1,
        archival: true,
    })

    const hashBase64 = hash.toString("base64")
    const rawTransaction = response.result?.find(
        item => item.transaction_id.lt === lt.toString() && item.transaction_id.hash === hashBase64,
    )
    if (rawTransaction === undefined) {
        throw new Error("getTransactions response does not contain requested transaction")
    }

    const [txCell] = Cell.fromBoc(Buffer.from(rawTransaction.data, "base64"))

    return {
        block: {
            workchain: block.workchain,
            seqno: block.seqno,
            shard: block.shard,
            rootHash: "",
            fileHash: "",
        },
        tx: loadTransaction(txCell.beginParse()),
    }
}

interface GetTransactionsResponse {
    ok: boolean
    error?: string
    code?: number
    result?: {
        data: string
        transaction_id: {
            lt: string
            hash: string
        }
    }[]
}

const GET_TRANSACTIONS_LIMIT = 1000

/**
 * Return the shard‑block header that contains a given
 * {@link RawTransaction}.
 *
 * @param network Toncenter-compatible network configuration.
 * @param tx       Raw transaction object.
 * @returns        The matching shard‑block or `undefined`
 *                 if Toncenter cannot find it.
 */
export const findShardBlockForTx = async (
    network: RetraceNetworkConfig,
    tx: RawTransaction,
): Promise<Block | undefined> => {
    const shard = tx.block

    const response = await toncenterV3Get<BlocksResponse>(network, "blocks", {
        workchain: shard.workchain,
        shard: toncenterV3ShardParam(shard.shard),
        seqno: shard.seqno,
    })

    return response.blocks[0]
}

/**
 * Return the smallest logical time for an account inside the shard block that
 * contains the target transaction.
 *
 * @param network Toncenter-compatible network configuration.
 * @param address  Account address.
 * @param block    Target transaction shard block reference.
 * @param targetLt Target transaction logical time.
 * @returns        The earliest account transaction lt in the same shard block.
 */
export const findMinLtInShardBlock = async (
    network: RetraceNetworkConfig,
    address: Address,
    block: RawTransaction["block"],
    targetLt: bigint,
): Promise<bigint> => {
    const response = await toncenterV3Get<TransactionData>(network, "transactions", {
        account: address.toRawString(),
        workchain: block.workchain,
        shard: toncenterV3ShardParam(block.shard),
        seqno: block.seqno,
        end_lt: targetLt.toString(),
        limit: GET_TRANSACTIONS_LIMIT,
        sort: "asc",
    })

    let minLt = targetLt
    for (const transaction of response.transactions) {
        const lt = BigInt(transaction.lt)
        if (lt < minLt) {
            minLt = lt
        }
    }

    return minLt
}

/**
 * Retrieve all transactions of a given account whose logical‑time
 * lies in the interval `(minLt, baseTx.lt]`, inclusive of `baseTx`.
 *
 * Used to reconstruct in‑block history before emulation.
 *
 * @param network Toncenter-compatible network configuration.
 * @param baseTx   The “upper bound” transaction.
 * @param minLt    Lower logical‑time boundary
 * @returns        Transactions ordered **newest → oldest**.
 */
export const findAllTransactionsBetween = async (
    network: RetraceNetworkConfig,
    baseTx: BaseTxInfo,
    minLt: bigint,
): Promise<Transaction[]> => {
    const response = await toncenterV2JsonRpc<GetTransactionsResponse>(network, "getTransactions", {
        address: toncenterAddressParam(network, baseTx.address),
        lt: baseTx.lt.toString(),
        to_lt: (minLt - 1n).toString(),
        hash: baseTx.hash.toString("base64"),
        limit: GET_TRANSACTIONS_LIMIT,
        archival: true,
    })

    const transactions = response.result ?? []
    const lastTransaction = transactions.at(-1)
    if (
        transactions.length === GET_TRANSACTIONS_LIMIT &&
        lastTransaction !== undefined &&
        BigInt(lastTransaction.transaction_id.lt) > minLt
    ) {
        throw new Error(
            `Too many account transactions in shard block: replay range exceeds ${GET_TRANSACTIONS_LIMIT}`,
        )
    }

    return transactions.map(rawTransaction => {
        const [transactionCell] = Cell.fromBoc(Buffer.from(rawTransaction.data, "base64"))
        return loadTransaction(transactionCell.beginParse())
    })
}

/**
 * Load the global configuration cell valid for the master‑block that
 * encloses the target transaction. Required by the TVM executor to
 * calculate gas, random‑seed and limits exactly as onchain.
 *
 * @param network Toncenter-compatible network configuration.
 * @param mcSeqno  Master-block sequence number.
 * @returns         Config cell as a string.
 */
export const getBlockConfig = async (
    network: RetraceNetworkConfig,
    mcSeqno: number,
): Promise<string> => {
    const response = await toncenterV2Get<GetConfigAllResponse>(network, "getConfigAll", {
        seqno: mcSeqno,
    })
    const bytes = response.result?.config?.bytes
    if (typeof bytes !== "string" || bytes.length === 0) {
        throw new Error("getConfigAll response is missing result.config.bytes")
    }
    return bytes
}

interface GetConfigAllResponse {
    ok: boolean
    error?: string
    code?: number
    result?: {
        config?: {
            bytes?: string
        }
    }
}

const MASTERCHAIN_SHARD = -(1n << 63n)
const MASTERCHAIN_SHARD_HEX = "8000000000000000"
const LAST_MC_BLOCKS_COUNT = 16

export interface PrevBlocksUsage {
    needed: boolean
    with100: boolean
}

/**
 * Detect whether the given code reads prev_blocks_info from c7 by
 * disassembling it and looking for the PREVBLOCKSINFOTUPLE,
 * PREVMCBLOCKS, PREVKEYBLOCK and PREVMCBLOCKS_100 instructions.
 *
 * Used to skip the relatively expensive prev-blocks fetch (a couple of
 * dozen toncenter requests) for the vast majority of contracts that
 * never touch it.
 */
export const detectPrevBlocksUsage = (roots: (Cell | undefined)[]): PrevBlocksUsage => {
    const found: Set<string> = new Set()
    for (const root of roots) {
        if (!root) {
            continue
        }
        try {
            collectInstructionNames(runtime.decompileCell(root), found)
        } catch {
            // not disassemblable — assume it does not use prev_blocks_info
        }
    }

    const with100 = found.has("PREVMCBLOCKS_100") || found.has("PREVBLOCKSINFOTUPLE")
    const needed = with100 || found.has("PREVMCBLOCKS") || found.has("PREVKEYBLOCK")
    return {needed, with100}
}

/**
 * Recursively collect the `$` discriminators of decompiled
 * instructions, including ones nested in continuations and method
 * dictionaries.
 */
function collectInstructionNames(value: unknown, found: Set<string>): void {
    if (Array.isArray(value)) {
        for (const item of value) {
            collectInstructionNames(item, found)
        }
        return
    }
    if (
        value === null ||
        typeof value !== "object" ||
        value instanceof Cell ||
        Buffer.isBuffer(value)
    ) {
        return
    }

    const name = (value as {$?: unknown}).$
    if (typeof name === "string") {
        found.add(name)
    }
    for (const item of Object.values(value)) {
        collectInstructionNames(item, found)
    }
}

/**
 * Collect prev_blocks_info for the TVM c7 context: the last 16
 * masterchain blocks (ending with the masterchain block that commits
 * the transaction), the previous key block and, when `with100` is set,
 * the last 16 masterchain blocks with seqno divisible by 100 (only
 * read by PREVMCBLOCKS_100).
 *
 * @param network Toncenter-compatible network configuration.
 * @param mcSeqno  Master‑block sequence number that contains the tx.
 * @param options  Set `with100` to also fetch `lastMcBlocks100`.
 */
export const getPrevBlocksInfo = async (
    network: RetraceNetworkConfig,
    mcSeqno: number,
    options?: {with100?: boolean},
): Promise<PrevBlocksInfo> => {
    const header = await toncenterV2Get<GetBlockHeaderResponse>(network, "getBlockHeader", {
        workchain: -1,
        shard: MASTERCHAIN_SHARD_HEX,
        seqno: mcSeqno,
    })

    const lastSeqnos: number[] = []
    for (let seqno = mcSeqno; seqno > Math.max(0, mcSeqno - LAST_MC_BLOCKS_COUNT); seqno--) {
        lastSeqnos.push(seqno)
    }

    const with100 = options?.with100 ?? false
    const seqnos100: number[] = []
    if (with100) {
        for (
            let seqno = mcSeqno - (mcSeqno % 100);
            seqno > 0 && seqnos100.length < LAST_MC_BLOCKS_COUNT;
            seqno -= 100
        ) {
            seqnos100.push(seqno)
        }
    }

    // sequential on purpose: parallel lookups hit the toncenter
    // per-IP rate limit, and this path is rare enough that a couple
    // of extra seconds do not matter
    const lookupAll = async (seqnos: number[]): Promise<BlockId[]> => {
        const blocks: BlockId[] = []
        for (const seqno of seqnos) {
            blocks.push(await lookupMasterchainBlock(network, seqno))
        }
        return blocks
    }

    const prevKeyBlock = await lookupMasterchainBlock(network, header.result.prev_key_block_seqno)
    const lastMcBlocks = await lookupAll(lastSeqnos)
    const lastMcBlocks100 = with100 ? await lookupAll(seqnos100) : undefined

    return {prevKeyBlock, lastMcBlocks, lastMcBlocks100}
}

interface LookupBlockResponse {
    ok: boolean
    result: {
        seqno: number
        root_hash: string
        file_hash: string
    }
}

interface GetBlockHeaderResponse {
    ok: boolean
    result: {
        prev_key_block_seqno: number
    }
}

async function lookupMasterchainBlock(
    network: RetraceNetworkConfig,
    seqno: number,
): Promise<BlockId> {
    const res = await toncenterV2Get<LookupBlockResponse>(network, "lookupBlock", {
        workchain: -1,
        shard: MASTERCHAIN_SHARD_HEX,
        seqno,
    })

    return {
        workchain: -1,
        shard: MASTERCHAIN_SHARD,
        seqno: res.result.seqno,
        rootHash: Buffer.from(res.result.root_hash, "base64"),
        fileHash: Buffer.from(res.result.file_hash, "base64"),
    }
}

/**
 * Return an account snapshot *before* the current master‑block.
 * The snapshot is converted to {@link ShardAccount} so it can be
 * directly fed into `runTransaction`.
 *
 * The raw ShardAccount cell is fetched from toncenter
 * `getShardAccountCell` and parsed as is, so every account field
 * (including `storage_extra`, which a reconstruction from the parsed
 * API would lose) is preserved.
 *
 * @param network Toncenter-compatible network configuration.
 * @param address   Account address.
 * @param mcSeqno   Master-block N sequence number (the one that contains the tx).
 * @returns         ShardAccount representing state on master‑block N‑1.
 */
export const getBlockAccount = async (
    network: RetraceNetworkConfig,
    address: Address,
    mcSeqno: number,
): Promise<ShardAccount> => {
    // The genesis state (block 0) is not available via any API: fall
    // back to the current block's state as best approximation.
    // stateUpdateHashOk will be false for genesis transactions.
    const seqno = mcSeqno > 1 ? mcSeqno - 1 : mcSeqno

    const {result} = await toncenterV2Get<GetShardAccountCellResponse>(
        network,
        "getShardAccountCell",
        {address: toncenterAddressParam(network, address), seqno},
    )
    if (typeof result !== "object" || typeof result.bytes !== "string") {
        throw new Error("getShardAccountCell response is missing result.bytes")
    }

    const cell = Cell.fromBase64(result.bytes)
    return loadShardAccount(cell.asSlice())
}

interface GetShardAccountCellResponse {
    ok: boolean
    error?: string
    code?: number
    result?:
        | string
        | {
              "@type": "tvm.cell"
              bytes?: string
          }
}

interface GetLibrariesResponse {
    ok: boolean
    error?: string
    code?: number
    result: {
        result: {
            hash: string
            data: string
        }[]
    }
}

/**
 * Load a library cell (T‑lib) from Toncenter by its 256‑bit hash.
 *
 * @param network Toncenter-compatible network configuration.
 * @param hash     Hex string of the library hash.
 * @returns        Decoded {@link Cell} containing actual code.
 * @throws         Error if the library is missing on the server.
 */
export const getLibraryByHash = async (
    network: RetraceNetworkConfig,
    hash: string,
): Promise<Cell> => {
    const response = await toncenterV2Get<GetLibrariesResponse>(network, "getLibraries", {
        libraries: hash,
    })
    const data = response.result.result[0]?.data
    if (typeof data !== "string" || data.length === 0) {
        throw new Error(`Toncenter library response does not contain library ${hash}`)
    }

    return Cell.fromBase64(data)
}

/**
 * Inspect the contract’s current code and (optionally) the init
 * code of the pending message, detect all **exotic library cells**
 * (tag 2) and build a dict mapping hash → real library code.
 *
 * @param network          Toncenter-compatible network configuration.
 * @param account          Current {@link ShardAccount} snapshot.
 * @param additionalLibs   Additional libraries to use.
 * @param tx               Transaction whose `inMessage` may include `Init`.
 * @returns                Serialized dict cell or `undefined`
 *                         when no libraries are referenced and actual code cell if
 *                         original code is just an exotic library cell
 */
export const collectUsedLibraries = async (
    network: RetraceNetworkConfig,
    account: ShardAccount,
    tx: Transaction,
    additionalLibs: [bigint, Cell][],
): Promise<[Cell | undefined, Cell | undefined]> => {
    const libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())

    const addMaybeExoticLibrary = async (code: Cell | undefined): Promise<Cell | undefined> => {
        const EXOTIC_LIBRARY_TAG = 2
        if (code === undefined) return undefined
        if (code.bits.length !== 256 + 8) return undefined // not an exotic library cell

        const cs = code.beginParse(true) // allow exotics
        const tag = cs.loadUint(8)
        if (tag !== EXOTIC_LIBRARY_TAG) return undefined // not a library cell

        const libHash = cs.loadBuffer(32)
        const libHashHex = libHash.toString("hex").toUpperCase()
        const actualCode = await getLibraryByHash(network, libHashHex)
        libs.set(BigInt(`0x${libHashHex}`), actualCode)
        return actualCode
    }

    // if current contract code is exotic cell, we want to return actual code to the user
    let loadedCellCode: Cell | undefined = undefined

    // 1. scan the *current* contract code for exotic‑library links
    const state = account.account?.storage.state
    if (state?.type === "active") {
        // The contract is already deployed and “active” so its `code`
        // cell may itself be a 264‑bit exotic library reference (tag 2).
        // If that’s the case, download the real library code and
        // register it in the `libs` dictionary.
        loadedCellCode = await addMaybeExoticLibrary(state.state.code ?? undefined)
    }

    // 2. scan the *incoming StateInit* (if present)
    const init = tx.inMessage?.init
    if (init) {
        // This transaction might *deploy* a brand‑new contract or
        // *upgrade* the existing one. Its `StateInit.code` could also
        // be an exotic library cell. We must preload such libraries as
        // well, otherwise the sandbox would fail to resolve a library
        // during emulation.
        loadedCellCode ??= await addMaybeExoticLibrary(init.code ?? undefined)
    }

    for (const [hash, lib] of additionalLibs) {
        libs.set(hash, lib)
    }

    // no libs found, return undefined, for emulator this means no libraries
    if (libs.size === 0) return [undefined, loadedCellCode]

    // emulator expects libraries as a Cell with immediate dictionary
    return [beginCell().storeDictDirect(libs).endCell(), loadedCellCode]
}

/**
 * Sequentially emulate the list of earlier transactions to roll
 * the shard‑account forward until the moment right before the
 * target transaction. Returns the updated balance and the new
 * base64‑encoded shard‑account string.
 *
 * @param prevBalance         Balance at the snapshot start.
 * @param prevTxsInBlock      Transactions to replay (oldest → newest).
 * @param emulate             Helper that runs a single transaction.
 * @param shardAccountBase64  Starting shard‑account (base64).
 * @returns                   `{ prevBalance, shardAccountBase64 }`
 *                            after applying all txs.
 */
export const emulatePreviousTransactions = async (
    prevBalance: bigint,
    prevTxsInBlock: Transaction[],
    emulate: (tx: Transaction, shardAccountStr: string) => Promise<EmulationResult>,
    shardAccountBase64: string,
): Promise<{prevBalance: bigint; shardAccountBase64: string}> => {
    if (prevTxsInBlock.length === 0) {
        return {prevBalance, shardAccountBase64}
    }

    for (const tx of prevTxsInBlock) {
        const res = await emulate(tx, shardAccountBase64)
        if (!res.result.success) {
            throw new Error(
                `Transaction failed for lt: ${tx.lt}, logs: ${res.logs}, debugLogs: ${res.debugLogs}`,
            )
        }

        // since we change state at each transaction we need to save new state as current one
        shardAccountBase64 = res.result.shardAccount

        const shardAccount = loadShardAccount(Cell.fromBase64(shardAccountBase64).asSlice())
        const newBalance = shardAccount.account?.storage.balance.coins

        prevBalance = newBalance ?? 0n
    }

    return {prevBalance, shardAccountBase64}
}

/**
 * Spin up TON Sandbox, configure verbosity, wrap the executor
 * into a convenience helper `emulate` and return both the helper
 * and the sandbox version metadata.
 *
 * @param blockConfig    Global config cell.
 * @param libs           Dict of referenced libraries or `undefined`.
 * @param randSeed       Random seed from master‑block header.
 * @param prevBlocksInfo Masterchain prev blocks info for the TVM c7
 *                       context or `undefined` (see {@link getPrevBlocksInfo}).
 * @returns              `{ emulatorVersion, emulate }`
 */
export const prepareEmulator = async (
    blockConfig: string,
    libs: Cell | undefined,
    randSeed: Buffer,
    prevBlocksInfo?: PrevBlocksInfo,
) => {
    const executor = await Executor.create()
    const emulatorVersion = executor.getVersion()

    async function emulate(tx: Transaction, shardAccountBase64: string): Promise<EmulationResult> {
        const inMsg = tx.inMessage
        if (!inMsg) throw new Error("No in_message was found in transaction")
        const messageCell =
            extractRawInMessageCell(tx) ?? beginCell().store(storeMessage(inMsg)).endCell()

        return executor.runTransaction({
            config: blockConfig,
            libs: libs ?? null,
            verbosity: "full_location_stack_verbose",
            shardAccount: shardAccountBase64,
            message: messageCell,
            now: tx.now,
            lt: tx.lt,
            randomSeed: randSeed,
            ignoreChksig: false,
            debugEnabled: true,
            prevBlocksInfo,
        })
    }

    async function emulateTickTock(
        which: TickOrTock,
        tx: Transaction,
        shardAccountBase64: string,
    ): Promise<EmulationResult> {
        return executor.runTickTock({
            config: blockConfig,
            libs: libs ?? null,
            verbosity: "full_location_stack_verbose",
            shardAccount: shardAccountBase64,
            which,
            now: tx.now,
            lt: tx.lt,
            randomSeed: randSeed,
            ignoreChksig: false,
            debugEnabled: true,
            prevBlocksInfo,
        })
    }

    return {emulatorVersion, emulate, emulateTickTock}
}

/**
 * Extract the original in-message cell from the raw transaction BoC.
 * Re-serializing the parsed message with `storeMessage` does not
 * always reproduce the on-chain cell bit for bit (e.g. for some
 * external-in messages), which changes forward fees and diverges the
 * emulated state, so the raw cell is preferred when available.
 */
function extractRawInMessageCell(tx: Transaction): Cell | null {
    try {
        const s = tx.raw.beginParse()
        s.loadUint(4) // transaction tag
        s.loadBuffer(32) // account_addr
        s.loadUintBig(64) // lt
        s.loadBuffer(32) // prev_trans_hash
        s.loadUintBig(64) // prev_trans_lt
        s.loadUint(32) // now
        s.loadUint(15) // outmsg_cnt
        s.loadUint(2) // orig_status
        s.loadUint(2) // end_status
        const inOut = s.loadRef().beginParse() // ^[ in_msg out_msgs ]
        const hasInMessage = inOut.loadBit()
        if (!hasInMessage) {
            return null
        }
        return inOut.loadRef()
    } catch {
        return null
    }
}

/**
 * Convert the raw `EmulationResultSuccess` plus the prior balance
 * into a structured set of money movements, compute‑phase stats and
 * convenience fields for higher‑level reporting.
 *
 * @param res            Successful result from TVM executor.
 * @param balanceBefore  Balance **before** the emulated tx.
 * @param contractAddress Address of the emulated contract. Used when
 *                        the transaction has no incoming message,
 *                        for example tick-tock transactions.
 * @returns              Breakdown containing sender/dest, amounts,
 *                       gas usage and the parsed `emulatedTx`.
 */
export const computeFinalData = (
    res: EmulationResultSuccess,
    balanceBefore: bigint,
    contractAddress?: Address,
) => {
    const shardAccount = loadShardAccount(Cell.fromBase64(res.shardAccount).asSlice())
    const endBalance = shardAccount.account?.storage.balance.coins ?? 0n

    const emulatedTx = loadTransaction(Cell.fromBase64(res.transaction).asSlice())

    let src: Address | undefined = undefined
    let dest: Address | undefined = undefined
    let amount: bigint | undefined = undefined

    if (emulatedTx.inMessage) {
        const msgSrc = emulatedTx.inMessage.info.src ?? undefined
        const msgDest = emulatedTx.inMessage.info.dest

        if (msgSrc !== undefined && !Address.isAddress(msgSrc)) {
            throw new Error(`Invalid src address: ${String(msgSrc)}`)
        }
        if (!Address.isAddress(msgDest)) {
            throw new Error(`Invalid dest address: ${String(msgDest)}`)
        }

        src = msgSrc
        dest = msgDest

        amount =
            emulatedTx.inMessage.info.type === "internal"
                ? emulatedTx.inMessage.info.value.coins
                : undefined
    } else if (contractAddress) {
        dest = contractAddress
    }

    if (!dest) {
        throw new Error("Cannot determine contract address")
    }

    const sentTotal = calculateSentTotal(emulatedTx)
    const totalFees = emulatedTx.totalFees.coins

    let computeInfo: ComputeInfo
    const desc = emulatedTx.description
    if (desc.type === "generic" || desc.type === "tick-tock") {
        const computePhase = desc.computePhase
        computeInfo =
            computePhase.type === "skipped"
                ? "skipped"
                : {
                      success: computePhase.success,
                      exitCode:
                          computePhase.exitCode === 0
                              ? (desc.actionPhase?.resultCode ?? 0)
                              : computePhase.exitCode,
                      vmSteps: computePhase.vmSteps,
                      gasUsed: computePhase.gasUsed,
                      gasFees: computePhase.gasFees,
                  }
    } else {
        throw new Error(
            "TxTracer doesn't support this transaction type. Given type: " +
                emulatedTx.description.type,
        )
    }

    const money: TraceMoneyResult = {
        balanceBefore,
        sentTotal,
        totalFees,
        balanceAfter: endBalance,
    }

    return {
        sender: src,
        contract: dest,
        money,
        emulatedTx,
        amount,
        computeInfo,
    }
}

/**
 * Extract the final `c5` register (action list) from emulation results,
 * decode it into an array of `OutAction`s and
 * return both the list and the original `c5` cell.
 *
 * @param res  Successful emulation result.
 * @returns    `{ finalActions, c5 }`
 */
export const findFinalActions = (res: EmulationResultSuccess) => {
    const actions = res.actions
    if (actions === null) {
        return {finalActions: [], c5: undefined}
    }

    try {
        const c5 = Cell.fromBase64(actions)
        const finalActions = loadOutList(c5.asSlice())
        return {finalActions, c5}
    } catch (error) {
        console.error(`Error decoding actions ${actions}:`, error)
        return {finalActions: [], c5: undefined}
    }
}

/**
 * Sum the value (`coins`) of every *internal* outgoing message
 * produced by a transaction. External messages are ignored since its
 * value is always 0.
 *
 * @param tx  Parsed {@link Transaction}.
 * @returns   Total toncoins sent out by the contract in this tx.
 */
export const calculateSentTotal = (tx: Transaction): bigint => {
    let total = 0n
    for (const msg of tx.outMessages.values()) {
        if (msg.info.type === "internal") {
            total += msg.info.value.coins
        }
    }
    return total
}

/**
 * Helper to serialize a {@link ShardAccount} object into base64
 * exactly as expected by `executor.runTransaction`.
 *
 * @param shardAccountBeforeTx  Account snapshot to serialize.
 * @returns                     Base64 string of the BOC‑encoded cell.
 */
export const shardAccountToBase64 = (shardAccountBeforeTx: ShardAccount) =>
    beginCell().store(storeShardAccount(shardAccountBeforeTx)).endCell().toBoc().toString("base64")
