import type {Address} from "@ton/core"
import {Buffer} from "buffer"
import type {RetraceNetworkConfig} from "./types"
import {wait} from "./utils"

const BASE_TIMEOUT = 20_000

// We do not usually want to ship API keys in source, but public Toncenter
// endpoints are effectively unusable for retrace without a key because retrace
// performs many block/config/account requests for a single transaction.
const DEFAULT_TONCENTER_API_KEY = "49efa980ccdcd018fd09d387e63537afd9db4dbb8509d69e7bc2303ca2b2c860"
const TONCENTER_API_KEY =
    (typeof process === "undefined" ? undefined : process.env["TONCENTER_API_KEY"]) ??
    DEFAULT_TONCENTER_API_KEY

interface ResolvedRetraceNetworkConfig extends RetraceNetworkConfig {
    testnet: boolean
    toncenterApiKey?: string
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "")

const resolveRetraceNetworkConfig = (
    network: RetraceNetworkConfig,
): ResolvedRetraceNetworkConfig => {
    const toncenterApiKey = network.toncenterApiKey?.trim()
    return {
        ...network,
        testnet: network.testnet ?? false,
        v2BaseUrl: normalizeBaseUrl(network.v2BaseUrl),
        v3BaseUrl: normalizeBaseUrl(network.v3BaseUrl),
        toncenterApiKey:
            toncenterApiKey === undefined || toncenterApiKey.length === 0
                ? undefined
                : toncenterApiKey,
    }
}

const apiUrl = (baseUrl: string, path: string): string =>
    `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, "")}`

/**
 * Toncenter v3 returns `block_ref.shard` as a 16-character unsigned hex string
 * without `0x`, for example, `8000000000000000`. Retrace passes this value
 * between v3 calls as-is, so keep the accepted format strict.
 */
export function toncenterV3ShardParam(shard: string): string {
    const trimmed = shard.trim()
    if (!/^[\dA-Fa-f]{16}$/.test(trimmed)) {
        throw new Error(`Invalid Toncenter v3 shard id: ${shard}`)
    }

    return trimmed.toLowerCase()
}

export function toncenterAddressParam(network: RetraceNetworkConfig, address: Address): string {
    return address.toString({testOnly: resolveRetraceNetworkConfig(network).testnet})
}

/**
 * Parse a TON 256-bit hash accepted by public APIs.
 *
 * Toncenter v3 stores transaction hashes as base64, while explorer URLs usually
 * carry hex hashes. Some APIs also return or accept base64url. Normalize all
 * three spellings to raw bytes once and derive endpoint-specific parameters from
 * those bytes.
 */
export function toncenterHashToBuffer(hash: string): Buffer {
    const trimmed = hash.trim()
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed
    if (/^[\dA-Fa-f]{64}$/.test(hex)) {
        return Buffer.from(hex, "hex")
    }

    if (/^[\w+/=-]{43,44}$/.test(trimmed)) {
        const base64 = trimmed.replace(/-/g, "+").replace(/_/g, "/")
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
        const result = Buffer.from(padded, "base64")
        if (result.length === 32) {
            return result
        }
    }

    throw new Error(`Invalid TON hash: ${hash}`)
}

export function toncenterV3HashParam(hash: string | Buffer): string {
    return Buffer.isBuffer(hash)
        ? hash.toString("base64")
        : toncenterHashToBuffer(hash).toString("base64")
}

export function toncenterV2HashParam(hash: string | Buffer): string {
    return Buffer.isBuffer(hash)
        ? hash.toString("base64")
        : toncenterHashToBuffer(hash).toString("base64")
}

const toncenterHeaders = (
    network: ResolvedRetraceNetworkConfig,
    headers: Record<string, string> = {},
): Record<string, string> => {
    if (network.toncenterApiKey === undefined || network.toncenterApiKey.length === 0) {
        return headers
    }

    return {...headers, "X-API-Key": network.toncenterApiKey}
}

type ToncenterParamValue = string | number | boolean

interface ToncenterGetOptions {
    params?: Record<string, ToncenterParamValue>
    headers?: Record<string, string>
}

class ToncenterHttpError extends Error {
    public constructor(
        public readonly status: number,
        public readonly detail: string,
    ) {
        super(`Toncenter HTTP ${status}`)
        this.name = "ToncenterHttpError"
    }
}

function buildUrl(url: string, params: Record<string, ToncenterParamValue> | undefined): string {
    const result = new URL(url)
    for (const [key, value] of Object.entries(params ?? {})) {
        result.searchParams.set(key, String(value))
    }
    return result.toString()
}

function responseDetail(body: string): string {
    if (body.length === 0) {
        return "empty response"
    }

    try {
        return JSON.stringify(JSON.parse(body) as unknown)
    } catch {
        return body
    }
}

function retryDelayMs(status: number | undefined, attempt: number): number | undefined {
    if (status === undefined) {
        return undefined
    }
    if (status === 429) {
        return 1000 * attempt
    }
    if (status >= 500) {
        return 150 * attempt
    }
    return undefined
}

async function toncenterGet<T>(
    network: ResolvedRetraceNetworkConfig,
    url: string,
    options: ToncenterGetOptions = {},
): Promise<T> {
    const RETRY_COUNT = 5
    const requestUrl = buildUrl(url, options.params)
    for (let attempt = 1; ; attempt++) {
        const abortController = new AbortController()
        const timeout = setTimeout(() => {
            abortController.abort()
        }, BASE_TIMEOUT)
        try {
            const response = await fetch(requestUrl, {
                headers: toncenterHeaders(network, options.headers ?? {}),
                signal: abortController.signal,
            })
            const body = await response.text()
            if (!response.ok) {
                throw new ToncenterHttpError(response.status, responseDetail(body))
            }

            return (body.length === 0 ? undefined : JSON.parse(body)) as T
        } catch (error: unknown) {
            if (!(error instanceof Error)) {
                throw error
            }

            const status = error instanceof ToncenterHttpError ? error.status : undefined
            const retryDelay = retryDelayMs(status, attempt)
            if (attempt < RETRY_COUNT && retryDelay !== undefined) {
                await wait(retryDelay)
                continue
            }

            const detail =
                error instanceof ToncenterHttpError
                    ? error.detail
                    : error.name === "AbortError"
                      ? `timeout after ${BASE_TIMEOUT}ms`
                      : error.message
            throw new Error(
                `Toncenter request failed: ${url}` +
                    (status === undefined ? "" : ` (${status})`) +
                    `, params: ${JSON.stringify(options.params ?? {})}, response: ${detail}`,
            )
        } finally {
            clearTimeout(timeout)
        }
    }
}

async function toncenterJsonRpc<T>(
    network: ResolvedRetraceNetworkConfig,
    url: string,
    method: string,
    params: Record<string, ToncenterParamValue>,
): Promise<T> {
    const RETRY_COUNT = 5
    const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
    })
    for (let attempt = 1; ; attempt++) {
        const abortController = new AbortController()
        const timeout = setTimeout(() => {
            abortController.abort()
        }, BASE_TIMEOUT)
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: toncenterHeaders(network, {"Content-Type": "application/json"}),
                body,
                signal: abortController.signal,
            })
            const responseBody = await response.text()
            if (!response.ok) {
                throw new ToncenterHttpError(response.status, responseDetail(responseBody))
            }

            return (responseBody.length === 0 ? undefined : JSON.parse(responseBody)) as T
        } catch (error: unknown) {
            if (!(error instanceof Error)) {
                throw error
            }

            const status = error instanceof ToncenterHttpError ? error.status : undefined
            const retryDelay = retryDelayMs(status, attempt)
            if (attempt < RETRY_COUNT && retryDelay !== undefined) {
                await wait(retryDelay)
                continue
            }

            const detail =
                error instanceof ToncenterHttpError
                    ? error.detail
                    : error.name === "AbortError"
                      ? `timeout after ${BASE_TIMEOUT}ms`
                      : error.message
            throw new Error(
                `Toncenter JSON-RPC request failed: ${url}` +
                    (status === undefined ? "" : ` (${status})`) +
                    `, method: ${method}, params: ${JSON.stringify(params)}, response: ${detail}`,
            )
        } finally {
            clearTimeout(timeout)
        }
    }
}

export async function toncenterV2Get<T extends {ok: boolean; error?: string; code?: number}>(
    network: RetraceNetworkConfig,
    method: string,
    params: Record<string, ToncenterParamValue>,
): Promise<T> {
    const networkConfig = resolveRetraceNetworkConfig(network)
    const response = await toncenterGet<T>(networkConfig, apiUrl(networkConfig.v2BaseUrl, method), {
        params,
    })
    if (!response.ok) {
        throw new Error(
            `${method} request failed: ${response.error ?? "unknown error"}` +
                (response.code === undefined ? "" : ` (code ${response.code})`),
        )
    }
    return response
}

export async function toncenterV2JsonRpc<T extends {ok: boolean; error?: string; code?: number}>(
    network: RetraceNetworkConfig,
    method: string,
    params: Record<string, ToncenterParamValue>,
): Promise<T> {
    const networkConfig = resolveRetraceNetworkConfig(network)
    const jsonRpcUrl = networkConfig.v2BaseUrl.endsWith("/jsonRPC")
        ? networkConfig.v2BaseUrl
        : apiUrl(networkConfig.v2BaseUrl, "jsonRPC")
    const response = await toncenterJsonRpc<T>(networkConfig, jsonRpcUrl, method, params)
    if (!response.ok) {
        throw new Error(
            `${method} JSON-RPC request failed: ${response.error ?? "unknown error"}` +
                (response.code === undefined ? "" : ` (code ${response.code})`),
        )
    }
    return response
}

export async function toncenterV3Get<T>(
    network: RetraceNetworkConfig,
    path: string,
    params: Record<string, ToncenterParamValue>,
): Promise<T> {
    const networkConfig = resolveRetraceNetworkConfig(network)
    return toncenterGet<T>(networkConfig, apiUrl(networkConfig.v3BaseUrl, path), {
        params,
    })
}

/**
 * Built-in Toncenter mainnet endpoints for retrace operations.
 */
export const RETRACE_MAINNET_NETWORK: RetraceNetworkConfig = {
    testnet: false,
    v2BaseUrl: "https://toncenter.com/api/v2",
    v3BaseUrl: "https://toncenter.com/api/v3",
    toncenterApiKey: TONCENTER_API_KEY,
}

/**
 * Built-in Toncenter testnet endpoints for retrace operations.
 */
export const RETRACE_TESTNET_NETWORK: RetraceNetworkConfig = {
    testnet: true,
    v2BaseUrl: "https://testnet.toncenter.com/api/v2",
    v3BaseUrl: "https://testnet.toncenter.com/api/v3",
    toncenterApiKey: TONCENTER_API_KEY,
}

/**
 * Return a network config with an optional Toncenter API key attached.
 * Empty keys are ignored, so callers can pass environment values directly.
 */
export function withRetraceNetworkApiKey(
    network: RetraceNetworkConfig,
    toncenterApiKey: string | undefined,
): RetraceNetworkConfig {
    const trimmedApiKey = toncenterApiKey?.trim()
    if (trimmedApiKey === undefined || trimmedApiKey.length === 0) {
        return network
    }

    return {...network, toncenterApiKey: trimmedApiKey}
}
