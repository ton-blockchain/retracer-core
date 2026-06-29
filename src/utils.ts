import {Buffer} from "buffer"
import {Address, beginCell} from "@ton/core"

export async function wait(delay: number): Promise<unknown> {
  return new Promise(resolve => setTimeout(resolve, delay))
}

export function base64ToBigint(b64: string): bigint {
  return BigInt("0x" + Buffer.from(b64, "base64").toString("hex"))
}

export function bigintToAddress(addr: bigint | undefined): Address | undefined {
  if (addr === undefined) return undefined

  try {
    const slice = beginCell().storeUint(4, 3).storeUint(0, 8).storeUint(addr, 256).asSlice()
    return slice.loadAddress()
  } catch {
    return undefined
  }
}
