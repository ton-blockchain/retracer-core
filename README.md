# retracer-core

**retracer-core** is a core library for deep analysis, emulation, and tracing transactions on the TON blockchain. The library allows you to reproduce transaction execution in a local sandbox, obtain detailed reports on computation, actions, and money flow, and collect low-level information about blocks, accounts, and messages.

## Features

- **Detailed transaction tracing**: Emulate transaction execution in an environment identical to TON blockchain's mainnet.
- **Block and account data collection**: Obtain account state snapshots, block configuration, and transaction history.
- **Work with libraries and contracts**: Automatic loading and handling of exotic library cells.
- **Analysis of incoming/outgoing messages, balance calculations, and VM log collection.**
- **Supports both mainnet and testnet.**

## Installation

```bash
yarn add @ton/retracer-core
# or
npm install @ton/retracer-core
```

## Quick Start

```ts
import {retrace} from "@ton/retracer-core"

// Example: trace a transaction by its hash
const result = await retrace(false, "YOUR_TX_HASH")
console.log(result)
```

## Main API

### Transaction Tracing

```ts
import {retrace} from "@ton/retracer-core"

/**
 * @param testnet - true for testnet, false for mainnet
 * @param txHash - hex transaction hash
 * @returns Detailed execution report (TraceResult)
 */
const result1 = await retrace(testnet, txHash)

/**
 * Retrace a transaction described as triple
 */
const result2 = await retraceBaseTx(testnet, {
    lt: 56166043000001n,
    hash: Buffer.from("T6Y6ZoW71mrznFA0RyU/xV5ILpz9WUPJ9i9/4xPq1Is=", "base64"),
    address: Address.parse("EQCqKZrrce8Ss6SZaLI-OkH2w8-xtPP9_ZvyyIZLhy9Hmpf8"),
})
```

### Helper Methods

All methods are exported from `retracer-core` and can be used independently:

- **findBaseTxByHash(testnet, txHash)** — Find base transaction info by hash.
- **findRawTxByHash(testnet, baseTxInfo)** — Get full transaction details.
- **findShardBlockForTx(testnet, rawTx)** — Find the shard block containing the transaction.
- **findFullBlockForSeqno(testnet, seqno)** — Get master-block by seqno.
- **findAllTransactionsBetween(testnet, baseTx, minLt)** — Get all account transactions in a given range.
- **getBlockConfig(testnet, blockInfo)** — Get global config for a block.
- **getBlockAccount(testnet, address, blockInfo)** — Get account snapshot before a block.
- **collectUsedLibraries(testnet, account, tx)** — Collect used library cells.
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

MIT © TON Studio, TON Core

## Links

- [TON Documentation](https://ton.org/docs/)
- [Source code & issue tracker](https://github.com/ton-blockchain/retracer-core)
