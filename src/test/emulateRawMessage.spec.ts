import {
  Address,
  beginCell,
  type Cell,
  external,
  internal,
  type Message,
  type ShardAccount,
  storeMessage,
  storeShardAccount,
  toNano,
} from "@ton/core"
import {createEmptyShardAccount, defaultConfig, TreasuryContract} from "@ton/sandbox"
import {Executor} from "@ton/sandbox/dist/executor/Executor"
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {emulateRawMessage} from "../runner"
import type {
  EmulatedMessage,
  EmulateRawMessageOptions,
  EmulateRawMessageResult,
  RetraceNetworkConfig,
} from "../types"

const NETWORK: RetraceNetworkConfig = {
  v2BaseUrl: "https://v2.invalid/api/v2",
  v3BaseUrl: "https://v3.invalid/api/v3",
}
const MC_SEQNO = 42
const NOW = 1_700_000_000
const START_LT = 1_000_000n
const RAND_SEED = Buffer.alloc(32, 7).toString("base64")
const SOURCE = Address.parseRaw(`0:${"11".repeat(32)}`)
const RECIPIENT = Address.parseRaw(`0:${"22".repeat(32)}`)
const FROZEN = Address.parseRaw(`0:${"33".repeat(32)}`)

describe("emulateRawMessage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(handleToncenterRequest))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("accepts Cell, hex and base64 inputs and validates emulation options", async () => {
    const message = serializeMessage(internalInbound(RECIPIENT), {forceRef: true})
    const options = singleAccountOptions(RECIPIENT)

    const fromCell = await emulateRawMessage(NETWORK, message, options)
    const fromHex = await emulateRawMessage(NETWORK, message.toBoc().toString("hex"), options)
    const fromBase64 = await emulateRawMessage(NETWORK, message.toBoc().toString("base64"), options)

    expect(fromHex.rootTxHash).toBe(fromCell.rootTxHash)
    expect(fromBase64.rootTxHash).toBe(fromCell.rootTxHash)
    expect(fromCell.trace.trace.in_msg_hash).toBe(message.hash().toString("hex"))
    expect(fromCell.trace.transactions[fromCell.rootTxHash]?.in_msg?.hash).toBe(
      message.hash().toString("hex"),
    )
    expect(summarizeResult(fromCell)).toMatchSnapshot()

    await expect(emulateRawMessage(NETWORK, "not-a-boc")).rejects.toThrow(
      "Raw message must be a Cell BoC encoded as hex or base64",
    )
    await expect(emulateRawMessage(NETWORK, message, {...options, mcSeqno: -1})).rejects.toThrow(
      "Masterchain block seqno must be a non-negative safe integer",
    )
    await expect(emulateRawMessage(NETWORK, message, {...options, now: -1})).rejects.toThrow(
      "Message emulation time must be a valid uint32",
    )
    await expect(emulateRawMessage(NETWORK, message, {...options, lt: -1n})).rejects.toThrow(
      "Message emulation lt must be a valid uint64 bigint",
    )
    await expect(
      emulateRawMessage(NETWORK, message, {...options, maxTransactions: 0}),
    ).rejects.toThrow("maxTransactions must be a positive safe integer")
    await expect(
      emulateRawMessage(NETWORK, message, {
        ...options,
        accountStateOverrides: {
          [RECIPIENT.toString()]: {shardAccountBoc: ""},
        },
      }),
    ).rejects.toThrow("Account state override cannot be empty")
  })

  it("emulates a deterministic message cascade and synthesizes its trace", async () => {
    const ignoreChksigValues: boolean[] = []
    const createExecutor = Executor.create.bind(Executor)
    vi.spyOn(Executor, "create").mockImplementation(async () => {
      const executor = await createExecutor()
      const runTransaction = executor.runTransaction.bind(executor)
      vi.spyOn(executor, "runTransaction").mockImplementation(async request => {
        ignoreChksigValues.push(request.ignoreChksig)
        return runTransaction(request)
      })
      return executor
    })
    const treasury = TreasuryContract.create(0, 123n)
    const recipientState = emptyShardAccount()
    const transfer = treasury.createTransfer({
      messages: [
        internal({
          to: RECIPIENT,
          value: toNano("1"),
          bounce: false,
          body: beginCell().storeUint(0x1234, 32).endCell(),
        }),
      ],
    })
    const message = serializeMessage(external({to: treasury.address, body: transfer}))
    const options: EmulateRawMessageOptions = {
      ...baseOptions(),
      ignoreChksig: true,
      accountStateOverrides: {
        [treasury.address.toString()]: {
          shardAccountBoc: shardAccountBoc(emptyShardAccount()),
          balance: toNano("100"),
          state: {
            type: "active",
            codeBoc: treasury.init.code?.toBoc().toString("base64"),
            dataBoc: treasury.init.data?.toBoc().toString("base64"),
          },
        },
        [RECIPIENT.toString()]: {
          shardAccountBoc: shardAccountBoc(recipientState),
          state: {type: "uninit"},
        },
      },
    }

    const result = await emulateRawMessage(NETWORK, message, options)

    expect(Object.keys(result.transactions)).toHaveLength(2)
    expect(result.trace.trace.children).toHaveLength(1)
    expect({ignoreChksigValues, result: summarizeResult(result)}).toMatchSnapshot()

    await expect(
      emulateRawMessage(NETWORK, message, {...options, maxTransactions: 1}),
    ).rejects.toThrow("Raw message emulation exceeded 1 transactions")
  })

  it("forwards ignoreChksig to the executor", async () => {
    const executor = await Executor.create()
    const runTransaction = vi.spyOn(executor, "runTransaction")
    vi.spyOn(Executor, "create").mockResolvedValue(executor)

    await emulateRawMessage(
      NETWORK,
      serializeMessage(internalInbound(RECIPIENT)),
      singleAccountOptions(RECIPIENT, {ignoreChksig: true}),
    )

    expect(runTransaction).toHaveBeenCalledOnce()
    expect(runTransaction.mock.calls[0]?.[0].ignoreChksig).toBe(true)
  })

  it("applies frozen state and scalar account overrides", async () => {
    const result = await emulateRawMessage(
      NETWORK,
      serializeMessage(internalInbound(FROZEN)),
      singleAccountOptions(FROZEN, {
        accountStateOverrides: {
          [FROZEN.toString()]: {
            shardAccountBoc: shardAccountBoc(emptyShardAccount()),
            balance: "9000000000",
            lastTransactionLt: "70",
            lastTransactionHash: "80",
            state: {type: "frozen", stateHash: "90"},
          },
        },
      }),
    )

    const transaction = result.trace.transactions[result.rootTxHash]
    expect(transaction.account_state_before).toMatchObject({
      balance: "9000000000",
      account_status: "frozen",
      frozen_hash: "000000000000000000000000000000000000000000000000000000000000005a",
    })
    expect(transaction.prev_trans_lt).toBe("70")
    expect(transaction.prev_trans_hash).toBe(
      "0000000000000000000000000000000000000000000000000000000000000050",
    )
    await expect(
      emulateRawMessage(
        NETWORK,
        serializeMessage(internalInbound(FROZEN)),
        singleAccountOptions(FROZEN, {
          accountStateOverrides: {
            [FROZEN.toString()]: {
              shardAccountBoc: shardAccountBoc(emptyShardAccount()),
              balance: "invalid",
            },
          },
        }),
      ),
    ).rejects.toThrow("balance must be an integer")

    await expect(
      emulateRawMessage(
        NETWORK,
        serializeMessage(internalInbound(FROZEN)),
        singleAccountOptions(FROZEN, {
          accountStateOverrides: {
            [FROZEN.toString()]: {
              shardAccountBoc: shardAccountBoc(emptyShardAccount()),
              balance: -1n,
            },
          },
        }),
      ),
    ).rejects.toThrow("balance must be a non-negative integer")

    await expect(
      emulateRawMessage(
        NETWORK,
        serializeMessage(internalInbound(FROZEN)),
        singleAccountOptions(FROZEN, {
          accountStateOverrides: {
            [FROZEN.toString()]: {
              shardAccountBoc: shardAccountBoc(createEmptyShardAccount(RECIPIENT)),
            },
          },
        }),
      ),
    ).rejects.toThrow("Account state override address does not match")
  })
})

function baseOptions(): EmulateRawMessageOptions {
  return {
    mcSeqno: MC_SEQNO,
    now: NOW,
    lt: START_LT,
  }
}

function singleAccountOptions(
  address: Address,
  overrides: Partial<EmulateRawMessageOptions> = {},
): EmulateRawMessageOptions {
  return {
    ...baseOptions(),
    accountStateOverrides: {
      [address.toString()]: {
        shardAccountBoc: shardAccountBoc(emptyShardAccount()),
      },
    },
    ...overrides,
  }
}

function internalInbound(destination: Address): Message {
  return {
    info: {
      type: "internal",
      ihrDisabled: true,
      bounce: false,
      bounced: false,
      src: SOURCE,
      dest: destination,
      value: {coins: toNano("2")},
      ihrFee: 0n,
      forwardFee: 0n,
      createdLt: 10n,
      createdAt: NOW,
    },
    init: null,
    body: beginCell().storeUint(0xabcdef01, 32).endCell(),
  }
}

function serializeMessage(message: Message, options?: {forceRef?: boolean}): Cell {
  return beginCell().store(storeMessage(message, options)).endCell()
}

function emptyShardAccount(): ShardAccount {
  return {
    account: null,
    lastTransactionHash: 0n,
    lastTransactionLt: 0n,
  }
}

function shardAccountBoc(shardAccount: ShardAccount): string {
  return beginCell().store(storeShardAccount(shardAccount)).endCell().toBoc().toString("base64")
}

async function handleToncenterRequest(input: string | URL | Request): Promise<Response> {
  const requestUrl =
    input instanceof Request ? input.url : input instanceof URL ? input.toString() : input
  const url = new URL(requestUrl)

  if (url.pathname.endsWith("/getConfigAll")) {
    return jsonResponse({ok: true, result: {config: {bytes: defaultConfig}}})
  }
  if (url.pathname.endsWith("/getMasterchainInfo")) {
    return jsonResponse({ok: true, result: {last: {seqno: MC_SEQNO}}})
  }
  if (url.pathname.endsWith("/blocks")) {
    return jsonResponse({
      blocks: [
        {
          rand_seed: RAND_SEED,
          gen_utime: String(NOW),
          end_lt: (START_LT - 1n).toString(),
        },
      ],
    })
  }

  throw new Error(`Unexpected Toncenter request: ${url}`)
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {"content-type": "application/json"},
  })
}

function summarizeResult(result: EmulateRawMessageResult) {
  return {
    rootTxHash: result.rootTxHash,
    stateUpdateHashOk: result.stateUpdateHashOk,
    traceMetadata: {
      traceId: result.trace.trace_id,
      externalHash: result.trace.external_hash,
      startLt: result.trace.start_lt,
      endLt: result.trace.end_lt,
      traceInfo: result.trace.trace_info,
    },
    trace: summarizeTraceNode(result.trace.trace),
    transactionsOrder: result.trace.transactions_order,
    transactions: result.trace.transactions_order.map(hash => {
      const transaction = result.trace.transactions[hash]
      const traceResult = result.transactions[hash]
      return {
        hash,
        account: transaction.account,
        lt: transaction.lt,
        now: transaction.now,
        prevTransactionHash: transaction.prev_trans_hash,
        prevTransactionLt: transaction.prev_trans_lt,
        description: transaction.description,
        inMessage: summarizeMessage(transaction.in_msg),
        outMessages: transaction.out_msgs.map(summarizeMessage),
        childTransactions: transaction.child_transactions,
        accountStateBefore: transaction.account_state_before,
        accountStateAfter: transaction.account_state_after,
        money: traceResult.money,
        computeInfo: traceResult.emulatedTx.computeInfo,
        actionCount: traceResult.emulatedTx.actions.length,
      }
    }),
  }
}

function summarizeMessage(message: EmulatedMessage | null) {
  if (!message) {
    return null
  }

  return {
    hash: message.hash,
    source: message.source,
    destination: message.destination,
    value: message.value,
    valueExtraCurrencies: message.value_extra_currencies,
    fwdFee: message.fwd_fee,
    ihrFee: message.ihr_fee,
    extraFlags: message.extra_flags,
    createdLt: message.created_lt,
    createdAt: message.created_at,
    opcode: message.opcode,
    ihrDisabled: message.ihr_disabled,
    bounce: message.bounce,
    bounced: message.bounced,
    importFee: message.import_fee,
  }
}

function summarizeTraceNode(node: EmulateRawMessageResult["trace"]["trace"]): unknown {
  return {
    txHash: node.tx_hash,
    inMessageHash: node.in_msg_hash,
    children: node.children?.map(summarizeTraceNode) ?? [],
  }
}
