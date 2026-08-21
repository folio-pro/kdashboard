// One normalized shape for the three autoscalers the app lists: HPA
// (autoscaling/v2), VPA (autoscaling.k8s.io/v1) and WPA (Datadog's
// WatermarkPodAutoscaler).
//
// The three answer the same two operator questions — "what is the metric doing
// right now" and "how many pods is that asking for" — through three different
// spec/status layouts. Rather than teach the table and the detail panel all
// three, everything funnels through `autoscalerSummary()` here, which is a pure
// function and therefore testable under `bun test` with no Svelte runtime.
//
// Every field is read defensively: a WPA is a CRD, so its payload is whatever
// the installed operator version writes, and a half-populated status is the
// normal state for the first seconds of an autoscaler's life.

import { parseCpuQuantity } from "$lib/stores/metrics.logic";
import type { Resource } from "$lib/types";

/** k8s renders a metric with no reading yet as `<unknown>`; so do we. */
export const UNKNOWN = "<unknown>";

export type AutoscalerFlavor = "hpa" | "vpa" | "wpa";

export interface AutoscalerTarget {
  /** What is being measured: "cpu", "memory", "nginx.requests", "api/cpu". */
  name: string;
  /** The metric source, as k8s names it (Resource, Pods, Object, External…). */
  source: string;
  /** Current reading, humanised. `UNKNOWN` before the first evaluation. */
  currentLabel: string;
  /** What it is aiming at: "80%", "100", or a WPA/VPA band "40 – 80". */
  targetLabel: string;
  /**
   * Fill for the meter, as a percentage of the ceiling. Null when there is no
   * reading yet, or when the flavour has no meaningful "how full" (VPA).
   */
  percent: number | null;
  /**
   * For a watermark band, where the low watermark sits on the same 0-100 scale
   * as `percent`, so the meter can shade the "do nothing" zone. Null otherwise.
   */
  lowPercent: number | null;
}

export interface AutoscalerCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface AutoscalerSummary {
  flavor: AutoscalerFlavor;
  /** "Deployment/api", or "-" when the object names no target. */
  reference: string;
  /** Replica bounds. Null throughout for VPA, which does not scale out. */
  min: number | null;
  max: number | null;
  current: number | null;
  desired: number | null;
  targets: AutoscalerTarget[];
  lastScaleTime: string | null;
  conditions: AutoscalerCondition[];
  /** Reason of an active ScalingLimited condition, else null. */
  limitedReason: string | null;
  /** True when the autoscaler is computing but deliberately not acting. */
  dryRun: boolean;
  /**
   * True when the targets fill towards a ceiling, so a meter is meaningful.
   * False for VPA — the single place this rule is decided, rather than each
   * layer re-deriving it from the flavour.
   */
  hasMeter: boolean;
  /** VPA only: Off / Initial / Recreate / Auto. */
  updateMode: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A quantity the API may send as a string ("800m") or a bare number. */
function quantity(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v === "") return null;
  const parsed = parseCpuQuantity(v);
  return Number.isFinite(parsed) ? parsed : null;
}

/** How a quantity should read in a cell: keep the API's own string when it
 *  gave us one, so "800m" does not become "0.8" behind the user's back. */
function quantityLabel(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  const n = num(v);
  return n === null ? null : String(n);
}

/**
 * A number and the string the API used for it. Every label on this screen needs
 * both — the number to size a bar, the original string so "800m" is not
 * silently rewritten as "0.8" — and keeping them together is what stops the
 * two from being derived separately at each use.
 */
interface Reading {
  label: string;
  value: number | null;
}

/** A metric already expressed as a percentage (HPA utilization targets). */
function percentReading(raw: unknown): Reading | null {
  const n = num(raw);
  return n === null ? null : { label: `${n}%`, value: n };
}

/** A metric expressed as a resource.Quantity ("800m", "1Gi", "62"). */
function quantityReading(raw: unknown): Reading | null {
  const label = quantityLabel(raw);
  return label === null ? null : { label, value: quantity(raw) };
}

/** How full `now` is against `ceiling`, or null when either is unknown. */
function fill(now: Reading | null, ceiling: Reading | null): number | null {
  if (now?.value == null || ceiling?.value == null) return null;
  return pct(now.value, ceiling.value);
}

function refLabel(ref: unknown): string {
  const r = obj(ref);
  const name = typeof r.name === "string" ? r.name : "";
  if (!name) return "-";
  return typeof r.kind === "string" && r.kind ? `${r.kind}/${name}` : name;
}

function pct(value: number, ceiling: number): number | null {
  if (!Number.isFinite(ceiling) || ceiling === 0) return null;
  return Math.round((value / ceiling) * 100);
}

function conditionsOf(status: Json): AutoscalerCondition[] {
  return arr(status.conditions)
    .map((c) => ({
      type: String(c.type ?? ""),
      status: String(c.status ?? ""),
      reason: typeof c.reason === "string" ? c.reason : undefined,
      message: typeof c.message === "string" ? c.message : undefined,
    }))
    .filter((c) => c.type !== "");
}

/** True when a condition of this type is present and active. */
function conditionActive(conditions: AutoscalerCondition[], type: string): boolean {
  return conditions.some((c) => c.type === type && c.status === "True");
}

function limitedFrom(conditions: AutoscalerCondition[]): string | null {
  const limited = conditions.find((c) => c.type === "ScalingLimited");
  if (!limited || limited.status !== "True") return null;
  return limited.reason ?? "ScalingLimited";
}

// ---------------------------------------------------------------------------
// HPA (autoscaling/v2, with an autoscaling/v1 fallback)
// ---------------------------------------------------------------------------

/**
 * The identity of a metric across spec and status. HPA guarantees neither the
 * ordering nor the length of `status.currentMetrics` matches `spec.metrics`
 * (an unreadable metric is simply absent), so pairing by index would silently
 * show one metric's reading under another's name.
 */
function metricKey(entry: Json): string {
  const type = String(entry.type ?? "Resource");
  switch (type) {
    case "ContainerResource": {
      const cr = obj(entry.containerResource);
      return `ContainerResource/${String(cr.name ?? "")}/${String(cr.container ?? "")}`;
    }
    case "Pods":
      return `Pods/${metricName(obj(entry.pods))}`;
    case "Object": {
      const o = obj(entry.object);
      return `Object/${metricName(o)}/${refLabel(o.describedObject)}`;
    }
    case "External":
      return `External/${metricName(obj(entry.external))}`;
    default:
      return `Resource/${String(obj(entry.resource).name ?? "")}`;
  }
}

/** Metric name across both spellings: v2's `metric.name`, WPA's `metricName`. */
function metricName(section: Json): string {
  const nested = obj(section.metric).name;
  if (typeof nested === "string" && nested !== "") return nested;
  return typeof section.metricName === "string" ? section.metricName : "";
}

/** The section of a metric entry that carries the target/current numbers. */
function metricSection(entry: Json): { source: string; section: Json } {
  const type = String(entry.type ?? "Resource");
  const key = type === "ContainerResource" ? "containerResource" : type.toLowerCase();
  return { source: type, section: obj(entry[key]) };
}

function displayName(source: string, section: Json): string {
  if (source === "Resource") return String(section.name ?? "metric");
  if (source === "ContainerResource") {
    return `${String(section.container ?? "")}/${String(section.name ?? "")}`.replace(/^\//, "");
  }
  return metricName(section) || "metric";
}

/** One spec metric with the status reading that belongs to it. */
interface MetricPair {
  source: string;
  /** The spec side: the target, or the pair of watermarks. */
  spec: Json;
  /**
   * The status side, as the API nests it — empty until the controller has read
   * the metric. HPA puts the numbers one level down under `current`; WPA puts
   * them directly on the section. Each reader unwraps its own shape rather
   * than this walker guessing which API it is looking at.
   */
  current: Json;
}

/**
 * Pair every declared metric with its reading, BY IDENTITY. Both HPA and WPA
 * keep `spec.metrics[]` and `status.currentMetrics[]` as independently ordered
 * lists — a metric the controller cannot read is simply absent from the status
 * — so pairing by index would show one metric's reading under another's name.
 */
function pairMetrics(spec: Json, status: Json): MetricPair[] {
  const readings = new Map<string, Json>();
  for (const entry of arr(status.currentMetrics)) readings.set(metricKey(entry), entry);

  return arr(spec.metrics).map((entry) => {
    const { source, section } = metricSection(entry);
    const reading = readings.get(metricKey(entry));
    return { source, spec: section, current: reading ? metricSection(reading).section : {} };
  });
}

/** An HPA metric aims at a point: a utilization percentage, or a quantity. */
function hpaTarget({ source, spec, current }: MetricPair): AutoscalerTarget {
  const goal = obj(spec.target);
  // Utilization is the common case and the only form already in percent;
  // every other target carries a quantity on both sides.
  // HPA nests the reading under `current` (MetricValueStatus).
  const reading = obj(current.current);
  const utilization = goal.averageUtilization !== undefined;
  const now = utilization
    ? percentReading(reading.averageUtilization)
    : quantityReading(reading.averageValue ?? reading.value);
  const aim = utilization
    ? percentReading(goal.averageUtilization)
    : quantityReading(goal.averageValue ?? goal.value);

  return {
    name: displayName(source, spec),
    source,
    currentLabel: now?.label ?? UNKNOWN,
    targetLabel: aim?.label ?? UNKNOWN,
    percent: fill(now, aim),
    lowPercent: null,
  };
}

/**
 * A WPA metric aims at a band, not a point: it scales up above the high
 * watermark and down below the low one, and does nothing in between.
 */
function wpaTarget({ source, spec, current }: MetricPair): AutoscalerTarget {
  const high = quantityReading(spec.highWatermark);
  const low = quantityReading(spec.lowWatermark);
  // A Resource metric may be reported as a utilization percentage rather than
  // a value, and the operator has used several spellings for the value form
  // over its life; take whichever one this cluster's version writes.
  const now =
    percentReading(current.currentAverageUtilization) ??
    quantityReading(
      current.currentValue ?? current.currentAverageValue ?? obj(current.current).averageValue,
    );

  return {
    name: displayName(source, spec),
    source,
    currentLabel: now?.label ?? UNKNOWN,
    targetLabel:
      low && high ? `${low.label} – ${high.label}` : (high?.label ?? low?.label ?? UNKNOWN),
    // Fill towards HIGH: that is the number that triggers a scale up.
    percent: fill(now, high),
    lowPercent: fill(low, high),
  };
}

/**
 * autoscaling/v1 keeps no `metrics[]` — it has one implicit CPU-utilization
 * metric spelled directly on the spec.
 */
function hpaV1Target(spec: Json, status: Json): AutoscalerTarget | null {
  const aim = percentReading(spec.targetCPUUtilizationPercentage);
  if (!aim) return null;
  const now = percentReading(status.currentCPUUtilizationPercentage);
  return {
    name: "cpu",
    source: "Resource",
    currentLabel: now?.label ?? UNKNOWN,
    targetLabel: aim.label,
    percent: fill(now, aim),
    lowPercent: null,
  };
}

function hpaTargets(spec: Json, status: Json): AutoscalerTarget[] {
  if (arr(spec.metrics).length > 0) return pairMetrics(spec, status).map(hpaTarget);
  const v1 = hpaV1Target(spec, status);
  return v1 ? [v1] : [];
}

// ---------------------------------------------------------------------------
// VPA (autoscaling.k8s.io VerticalPodAutoscaler)
// ---------------------------------------------------------------------------

/** "100m – 1", "≤ 1", "≥ 100m", or `UNKNOWN` when the recommender gave neither. */
function boundsLabel(lower: string | null, upper: string | null): string {
  if (lower && upper) return `${lower} – ${upper}`;
  if (upper) return `≤ ${upper}`;
  if (lower) return `≥ ${lower}`;
  return UNKNOWN;
}

/**
 * A VPA never changes the replica count, so it has no meter to fill: what
 * changes over time is the recommendation itself. Each container/resource pair
 * becomes one row reading "target (lower – upper)".
 */
function vpaTargets(status: Json): AutoscalerTarget[] {
  const recommendations = arr(obj(status.recommendation).containerRecommendations);
  const targets: AutoscalerTarget[] = [];

  for (const rec of recommendations) {
    const container = String(rec.containerName ?? "");
    const target = obj(rec.target);
    const lower = obj(rec.lowerBound);
    const upper = obj(rec.upperBound);

    for (const resourceName of ["cpu", "memory"]) {
      const targetLabel = quantityLabel(target[resourceName]);
      if (targetLabel === null) continue;
      const lowerLabel = quantityLabel(lower[resourceName]);
      const upperLabel = quantityLabel(upper[resourceName]);
      targets.push({
        name: container ? `${container}/${resourceName}` : resourceName,
        source: "Recommendation",
        currentLabel: targetLabel,
        // A one-sided recommendation still has to read as a bound: the bare
        // number would render as "250m/100m", which looks like a target.
        targetLabel: boundsLabel(lowerLabel, upperLabel),
        // No ceiling to fill towards: the recommendation IS the value.
        percent: null,
        lowPercent: null,
      });
    }
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Which normalizer a resource needs, from its kind or its list type. */
export function autoscalerFlavor(kindOrType: string): AutoscalerFlavor | null {
  switch (kindOrType.toLowerCase()) {
    case "hpa":
    case "horizontalpodautoscaler":
    case "horizontalpodautoscalers":
      return "hpa";
    case "vpa":
    case "verticalpodautoscaler":
    case "verticalpodautoscalers":
      return "vpa";
    case "wpa":
    case "watermarkpodautoscaler":
    case "watermarkpodautoscalers":
      return "wpa";
    default:
      return null;
  }
}

/**
 * Normalize any of the three autoscalers. `flavor` may be passed when the
 * caller already knows it (the table knows its resource type); otherwise it is
 * inferred from the resource's own kind, and an unrecognised kind is treated as
 * an HPA, whose layout is the one the other two borrow from.
 */
export function autoscalerSummary(
  resource: Resource,
  flavor?: AutoscalerFlavor,
): AutoscalerSummary {
  const spec = obj(resource.spec);
  const status = obj(resource.status);
  const kind = flavor ?? autoscalerFlavor(resource.kind ?? "") ?? "hpa";
  const conditions = conditionsOf(status);

  const targets =
    kind === "wpa" ? pairMetrics(spec, status).map(wpaTarget)
    : kind === "vpa" ? vpaTargets(status)
    : hpaTargets(spec, status);

  // A VPA neither scales out nor fills towards a ceiling: its recommendation
  // IS the value, so there is no replica range and no meter that could move.
  const scalesOut = kind !== "vpa";

  return {
    flavor: kind,
    // VPA names its subject `targetRef`; HPA and WPA use `scaleTargetRef`.
    reference: refLabel(spec.scaleTargetRef ?? spec.targetRef),
    min: scalesOut ? num(spec.minReplicas) : null,
    max: scalesOut ? num(spec.maxReplicas) : null,
    current: scalesOut ? num(status.currentReplicas) : null,
    desired: scalesOut ? num(status.desiredReplicas) : null,
    targets,
    lastScaleTime: typeof status.lastScaleTime === "string" ? status.lastScaleTime : null,
    conditions,
    limitedReason: limitedFrom(conditions),
    // WPA publishes dry-run both ways: `spec.dryRun` is what the object asks
    // for, the DryRun condition is what the controller actually decided (it can
    // be forced on operator-wide). Either one means nothing is being scaled.
    dryRun: spec.dryRun === true || conditionActive(conditions, "DryRun"),
    hasMeter: scalesOut,
    updateMode:
      kind === "vpa"
        ? ((obj(spec.updatePolicy).updateMode as string | undefined) ?? null)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Cell formatting
// ---------------------------------------------------------------------------

/** k9s' TARGETS column: "cpu: 45%/80%, memory: <unknown>/70%". */
export function formatTargets(summary: AutoscalerSummary, max = 2): string {
  const parts = summary.targets.map((t) => `${t.name}: ${t.currentLabel}/${t.targetLabel}`);
  if (parts.length === 0) return "-";
  if (parts.length <= max) return parts.join(", ");
  return `${parts.slice(0, max).join(", ")} +${parts.length - max}`;
}

/** k9s' REPLICAS column, showing the gap the autoscaler is trying to close. */
export function formatReplicas(summary: AutoscalerSummary): string {
  if (summary.current === null && summary.desired === null) return "-";
  const current = summary.current ?? 0;
  const desired = summary.desired ?? current;
  return current === desired ? String(current) : `${current} → ${desired}`;
}
