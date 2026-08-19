// Kubernetes resource.Quantity parsing.
//
// Shared by the cost handlers (which price usage) and the metrics handlers
// (which display it), so both read a "250m" / "1Gi" string the same way.
//
// The renderer has its own copy in src/lib/stores/metrics.logic.ts — the two
// processes cannot share a module (the Electron tsconfig roots at electron/),
// so the suffix tables below and there must stay in step.

/** Binary (power-of-two) suffixes, largest last. */
const BINARY: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

/** Decimal suffixes. `m` is milli — legal on memory, and one thousandth. */
const DECIMAL: Record<string, number> = {
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

function parseWithSuffixes(value: string, extra: Record<string, number>): number {
  // Binary suffixes are two characters, so they must be tested first: "Mi"
  // would otherwise match the decimal "M" and come out 1.05x too small.
  for (const [suffix, factor] of Object.entries(BINARY)) {
    if (value.endsWith(suffix)) {
      return (Number.parseFloat(value.slice(0, -suffix.length)) || 0) * factor;
    }
  }
  for (const [suffix, factor] of Object.entries(extra)) {
    if (value.endsWith(suffix)) {
      return (Number.parseFloat(value.slice(0, -suffix.length)) || 0) * factor;
    }
  }
  return Number.parseFloat(value) || 0;
}

/**
 * CPU quantity -> cores. metrics-server reports nanocores ("123456789n"), the
 * API takes millicores ("250m"), and both round-trip through here.
 */
export function parseCpu(cpuStr: string): number {
  if (cpuStr.endsWith('n')) {
    return (Number.parseFloat(cpuStr.slice(0, -1)) || 0) / 1e9;
  }
  if (cpuStr.endsWith('u')) {
    return (Number.parseFloat(cpuStr.slice(0, -1)) || 0) / 1e6;
  }
  return parseWithSuffixes(cpuStr, DECIMAL);
}

/** Memory quantity -> bytes, across the full binary and decimal suffix sets. */
export function parseMemory(memStr: string): number {
  return parseWithSuffixes(memStr, DECIMAL);
}
