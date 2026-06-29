import {describe, expect, it} from "vitest"
import {findBaseTxByHash} from "../methods"
import {
  RETRACE_MAINNET_NETWORK,
  RETRACE_TESTNET_NETWORK,
  toncenterV2HashParam,
  toncenterV3HashParam,
  withRetraceNetworkApiKey,
} from "../networks"
import {retrace, retraceBaseTx} from "../runner"
import type {TraceResult} from "../types"

const DEFAULT_TIMEOUT = 100_000
const TONCENTER_API_KEY = process.env["TONCENTER_API_KEY"]
const MAINNET_NETWORK = withRetraceNetworkApiKey(RETRACE_MAINNET_NETWORK, TONCENTER_API_KEY)
const TESTNET_NETWORK = withRetraceNetworkApiKey(RETRACE_TESTNET_NETWORK, TONCENTER_API_KEY)

describe("toncenter hash params", () => {
  it("normalizes explorer hex and base64url hashes", () => {
    const hex = "2b66caa2d3f90d4d32f699c63d2f2bd430b645772e8d457b57e3c640c07d65ba"
    const base64 = "K2bKotP5DU0y9pnGPS8r1DC2RXcujUV7V+PGQMB9Zbo="
    const base64url = "K2bKotP5DU0y9pnGPS8r1DC2RXcujUV7V-PGQMB9Zbo"

    expect(toncenterV3HashParam(hex)).toBe(base64)
    expect(toncenterV3HashParam(`0x${hex}`)).toBe(base64)
    expect(toncenterV3HashParam(base64url)).toBe(base64)
    expect(toncenterV2HashParam(base64url)).toBe(base64)
  })
})

describe("transactions", () => {
  it(
    "should return correct information for transaction without libs and exit code 709",
    async () => {
      const txLink = "3c1b02a33390e596d83b306eab57b3f7271bc90e2e527ea4cafccfde25139d41"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for simple transaction with exit code 0",
    async () => {
      const txLink = "9432b11f810c58b38658cbc41c52dd01cf3af18e950d375dcc867077554e4550"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for transaction on account with storage_extra and code with PREVMCBLOCKS",
    async () => {
      const txLink = "dfee011f44a906e28ba43f5c6f1027d57573f7dc929fa81fa6544c8013248b41"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for transaction for code with single exotic library cell",
    async () => {
      const txLink = "4295a2c06ca9b0242d4b6638e4eb1a8da91a9d75dbeae4acc13a4355a4dd7a6a"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for transaction for code with several exotic library cells",
    async () => {
      const txLink = "440e0490bd5efee08b23cf33e2cfd9b8d414c4cb717d3f92727fa49d4c51a09d"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for transaction with external-in message for wallet v5",
    async () => {
      const txLink = "d6b814f76ec8cae17664ceba18b978e510f2249b36a35bf7227db121c1516e96"

      // previously diverged because the re-serialized external-in
      // message didn't match the on-chain cell; fixed by emulating
      // with the raw in-message cell
      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for transaction with external-in message for wallet v4",
    async () => {
      const txLink = "f8b7a5b598c65ecb180338eec103bf28c199bf8346453342eb7022ccf2ea39f6"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for transaction for uninit transaction with StateInit code",
    async () => {
      const txLink = "5abe43cce74d536cdae76b989e55f7b37c61381308b8f1a4b8ecc3098c4b8b39"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for transaction with exotic cell library in in-message",
    async () => {
      const txLink = "f64c6a3cdf3fad1d786aacf9a6130f18f3f76eeb71294f53bbd812ad3703e70a"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for base transaction",
    async () => {
      const baseTx = await findBaseTxByHash(
        MAINNET_NETWORK,
        "4fa63a6685bbd66af39c503447253fc55e482e9cfd5943c9f62f7fe313ead48b",
      )
      if (baseTx === undefined) {
        throw new Error("Cannot find base transaction")
      }

      const res = await retraceBaseTx(MAINNET_NETWORK, baseTx)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should return correct information for transaction with library load from mainnet",
    async () => {
      const txLink = "a63b8b2f4b4493de5e67031ba3d65c7a8c0938ab56327608fb42bcbee901e4b7"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )
})

describe("tick-tock transactions", () => {
  it(
    "should return correct information for tick transaction on elector",
    async () => {
      const txLink = "0c0bb916b6297b75a3fed6dd95d5126bdd293e8e066918482a31238ebba2dc62"

      const res = await retrace(MAINNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )

  it(
    "should handle genesis block tick-tock transaction on elector (block 1)",
    async () => {
      // First tick-tock transaction on the elector in block 1 (genesis)
      const txLink = "31a7668dad7b8a2c2d0e5290e5a0aef69f746f12c405eea133895fe70e063185"

      const res = await retrace(MAINNET_NETWORK, txLink)
      // Genesis block state is not available via APIs, so stateUpdateHashOk will be false
      checkResult(res, false)
    },
    DEFAULT_TIMEOUT,
  )
})

describe("TVM version support", () => {
  it(
    "v12",
    async () => {
      const txLink = "fadd5a2d53a26c4e8694e9e992c4f53f981655593b24847f19727c1140a255be"

      const res = await retrace(TESTNET_NETWORK, txLink)
      checkResult(res)
    },
    DEFAULT_TIMEOUT,
  )
})

function checkResult(res: TraceResult, expectedOk: boolean = true): void {
  expect(res.stateUpdateHashOk).toEqual(expectedOk)
  expect(res.codeCell?.toBoc().toString("hex")).toMatchSnapshot()
  expect(res.originalCodeCell?.toBoc().toString("hex")).toMatchSnapshot()
  expect(res.inMsg.sender?.toString()).toMatchSnapshot()
  expect("0x" + res.inMsg.opcode?.toString(16)).toMatchSnapshot()
  expect(res.inMsg.contract.toString()).toMatchSnapshot()
  expect(res.inMsg.amount).toMatchSnapshot()
  expect(res.emulatedTx.lt).toMatchSnapshot()
  expect(res.emulatedTx.utime).toMatchSnapshot()
  expect(res.emulatedTx.computeInfo).toMatchSnapshot()
  expect(res.emulatedTx.c5?.toString()).toMatchSnapshot()
  expect(res.emulatedTx.raw).toMatchSnapshot()
  expect(res.money).toMatchSnapshot()
}
