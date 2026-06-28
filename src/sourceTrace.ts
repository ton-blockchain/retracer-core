import type {
    BuildSourceTraceRequest,
    RetraceSourceTraceOptions,
    SourceTraceResponse,
    TraceResult,
} from "./types"
import {ActonSourceTraceWasmBase64} from "./generated/actonSourceTraceWasm"
import initSourceTraceWasm, {build_source_trace} from "./generated/actonSourceTraceWasmGlue"

let initSourceTraceWasmPromise: Promise<unknown> | undefined
let defaultWasmBytes: Uint8Array | undefined

export async function buildSourceTrace(
    request: BuildSourceTraceRequest,
): Promise<SourceTraceResponse> {
    if (request.compiled.debugMarksJson.length === 0) {
        throw new Error("Source-level retrace requires debugMarksJson")
    }
    if (request.compiled.debugMarksBase64.trim() === "") {
        throw new Error("Source-level retrace requires debugMarksBase64")
    }

    await initWasm()
    return build_source_trace(request) as SourceTraceResponse
}

export async function buildSourceTraceForTraceResult(
    result: TraceResult,
    options: RetraceSourceTraceOptions,
): Promise<SourceTraceResponse> {
    if (!result.codeCell) {
        throw new Error("Source-level retrace requires executable code")
    }
    if (!result.emulatedTx.vmLogs) {
        throw new Error("Source-level retrace requires VM logs")
    }

    const senderAddress = result.inMsg.sender?.toString()
    return buildSourceTrace({
        vmLogs: result.emulatedTx.vmLogs,
        codeHash: result.codeCell.hash().toString("hex"),
        sourceBundle: options.sourceBundle,
        context:
            senderAddress === undefined
                ? undefined
                : {
                      inMsg: {
                          senderAddress,
                      },
                  },
        compiled: options.sourceMap,
    })
}

async function initWasm(): Promise<unknown> {
    initSourceTraceWasmPromise ??= initSourceTraceWasm({module_or_path: getDefaultWasmBytes()})
    return initSourceTraceWasmPromise
}

function getDefaultWasmBytes(): Uint8Array {
    defaultWasmBytes ??= base64ToBytes(ActonSourceTraceWasmBase64)
    return defaultWasmBytes
}

function base64ToBytes(value: string): Uint8Array {
    if (typeof globalThis.atob === "function") {
        const binary = globalThis.atob(value)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.codePointAt(index) ?? 0
        }
        return bytes
    }

    if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(value, "base64"))
    }

    throw new Error("No base64 decoder is available in this runtime")
}
