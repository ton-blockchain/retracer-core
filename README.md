# retracer-core

**retracer-core** is a core library for deep analysis, emulation, and tracing transactions on the TON blockchain. The library allows you to reproduce transaction execution in a local sandbox, obtain detailed reports on computation, actions, and money flow, and collect low-level information about blocks, accounts, and messages.

## Features

- **Detailed transaction tracing**: Emulate transaction execution in an environment identical to TON blockchain's mainnet.
- **Block and account data collection**: Obtain account state snapshots, block configuration, and transaction history.
- **Work with libraries and contracts**: Automatic loading and handling of exotic library cells.
- **Analysis of incoming/outgoing messages, balance calculations, and VM log collection.**
- **Supports mainnet, testnet, and custom Toncenter-compatible endpoints.**

## Installation

```bash
yarn add @ton/retracer-core
# or
npm install @ton/retracer-core
```

## Quick Start

```ts
import {RETRACE_MAINNET_NETWORK, retrace} from "@ton/retracer-core"

// Example: trace a transaction by its hash
const result = await retrace(RETRACE_MAINNET_NETWORK, "YOUR_TX_HASH")
console.log(result)
```

## Main API

### Transaction Tracing

```ts
import {
  RETRACE_MAINNET_NETWORK,
  RETRACE_TESTNET_NETWORK,
  findBaseTxByHash,
  retrace,
  retraceBaseTx,
} from "@ton/retracer-core"
import type {RetraceNetworkConfig} from "@ton/retracer-core"

/**
 * @param network - Toncenter-compatible network configuration
 * @param txHash - hex transaction hash
 * @returns Detailed execution report (TraceResult)
 */
const result1 = await retrace(RETRACE_MAINNET_NETWORK, txHash)
const result2 = await retrace(RETRACE_TESTNET_NETWORK, txHash)

const customNetwork: RetraceNetworkConfig = {
  testnet: true,
  v2BaseUrl: "https://example.com/api/v2",
  v3BaseUrl: "https://example.com/api/v3",
  toncenterApiKey: "optional-api-key",
}
const result3 = await retrace(customNetwork, txHash)

/**
 * Retrace a transaction described by base transaction information.
 * Base transaction info should be resolved through the same network first,
 * because it carries the Toncenter v3 shard block reference.
 */
const baseTx = await findBaseTxByHash(RETRACE_MAINNET_NETWORK, txHash)
if (baseTx === undefined) {
  throw new Error("Transaction not found")
}
const result4 = await retraceBaseTx(RETRACE_MAINNET_NETWORK, baseTx)
```

### Helper Methods

All methods are exported from `retracer-core` and can be used independently:

- **findBaseTxByHash(network, txHash)** — Find base transaction info by hash.
- **findRawTxByHash(network, baseTxInfo)** — Get the raw transaction BoC and shard reference.
- **findShardBlockForTx(network, rawTx)** — Find the shard block containing the transaction.
- **findMinLtInShardBlock(network, address, block, targetLt)** — Find the earliest account transaction lt in the same shard block.
- **findAllTransactionsBetween(network, baseTx, minLt)** — Get all account transactions in a given range.
- **getBlockConfig(network, mcSeqno)** — Get global config for a masterchain block.
- **getBlockAccount(network, address, mcSeqno)** — Get account snapshot before a masterchain block.
- **collectUsedLibraries(network, account, tx)** — Collect used library cells.
- **prepareEmulator(blockConfig, libs, randSeed)** — Prepare the emulator for transaction execution.
- **emulatePreviousTransactions(...)** — Emulate a chain of previous transactions to restore the state.
- **computeFinalData(...)** — Gather final data from emulation result.
- **findFinalActions(logs)** — Extract final actions from VM logs.
- **shardAccountToBase64(shardAccount)** — Serialize an account to base64 for the emulator.

## Types

All main types (transactions, blocks, messages, tracing results) are exported from `retracer-core` and are fully typed (see [src/types.ts](src/types.ts)).

## Projects based on retracer-core

- [TxTracer](https://txtracer.ton.org) — Web application for tracing and debugging any TON blockchain transactions

## License

MIT © TON Core, TON Studio

## Links

- [TON Documentation](https://ton.org/docs/)
- [Source code & issue tracker](https://github.com/ton-blockchain/retracer-core)
