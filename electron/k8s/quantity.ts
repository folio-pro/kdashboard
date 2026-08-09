// Kubernetes resource.Quantity parsing (port of the Rust metrics.rs helpers).
//
// Shared by the cost handlers (which price usage) and the metrics handlers
// (which display it), so both read a "250m" / "1Gi" string the same way.

/** CPU quantity ("250m", "1500u", "3000000n", "2") -> cores. */
export function parseCpu(cpuStr: string): number {
  if (cpuStr.endsWith('n')) {
    return (Number.parseFloat(cpuStr.slice(0, -1)) || 0) / 1_000_000_000.0;
  }
  if (cpuStr.endsWith('u')) {
    return (Number.parseFloat(cpuStr.slice(0, -1)) || 0) / 1_000_000.0;
  }
  if (cpuStr.endsWith('m')) {
    return (Number.parseFloat(cpuStr.slice(0, -1)) || 0) / 1000.0;
  }
  return Number.parseFloat(cpuStr) || 0;
}

/** Memory quantity ("128Mi", "1Gi", "512M") -> bytes. */
export function parseMemory(memStr: string): number {
  if (memStr.endsWith('Ki')) {
    return (Number.parseFloat(memStr.slice(0, -2)) || 0) * 1024.0;
  }
  if (memStr.endsWith('Mi')) {
    return (Number.parseFloat(memStr.slice(0, -2)) || 0) * 1024.0 * 1024.0;
  }
  if (memStr.endsWith('Gi')) {
    return (Number.parseFloat(memStr.slice(0, -2)) || 0) * 1024.0 * 1024.0 * 1024.0;
  }
  if (memStr.endsWith('Ti')) {
    return (Number.parseFloat(memStr.slice(0, -2)) || 0) * 1024.0 * 1024.0 * 1024.0 * 1024.0;
  }
  if (memStr.endsWith('k')) {
    return (Number.parseFloat(memStr.slice(0, -1)) || 0) * 1000.0;
  }
  if (memStr.endsWith('M')) {
    return (Number.parseFloat(memStr.slice(0, -1)) || 0) * 1_000_000.0;
  }
  if (memStr.endsWith('G')) {
    return (Number.parseFloat(memStr.slice(0, -1)) || 0) * 1_000_000_000.0;
  }
  return Number.parseFloat(memStr) || 0;
}
