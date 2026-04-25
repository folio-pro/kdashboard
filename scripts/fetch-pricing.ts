#!/usr/bin/env bun
// Fetches cloud instance pricing from instances.vantage.sh for AWS, Azure, GCP.
// Normalises into a compact, kdashboard-shaped JSON keyed by region/instance_type.
// Output goes to ./pricing-out/ to be uploaded as release assets by CI.
//
// Source attribution: instances.vantage.sh / vantage-sh/ec2instances.info (AGPL data).
// We only redistribute pricing facts (not the dataset code), normalised into our schema.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type NormalisedInstance = {
  vcpu: number;
  memory_gb: number;
  ondemand_usd_hour: number | null;
  spot_usd_hour: number | null;
};

type NormalisedDataset = {
  version: string;
  generated_at: string;
  source: string;
  provider: "aws" | "azure" | "gcp";
  region_count: number;
  instance_count: number;
  // region -> instance_type -> price entry
  instances: Record<string, Record<string, NormalisedInstance>>;
};

const VANTAGE = {
  aws: "https://instances.vantage.sh/instances.json",
  azure: "https://instances.vantage.sh/azure/instances.json",
  gcp: "https://instances.vantage.sh/gcp/instances.json",
} as const;

const OUT_DIR = join(import.meta.dir, "..", "pricing-out");

function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? parseFloat(value) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": "kdashboard-pricing-fetcher/1.0" },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

type AwsInstance = {
  instance_type: string;
  vCPU: number;
  memory: number;
  pricing: Record<
    string,
    Partial<{
      linux: { ondemand?: string; spot_min?: string };
    }>
  >;
};

function normaliseAws(raw: AwsInstance[]): NormalisedDataset {
  const instances: NormalisedDataset["instances"] = {};
  let count = 0;

  for (const it of raw) {
    if (!it.instance_type || !it.pricing) continue;

    for (const [region, price] of Object.entries(it.pricing)) {
      const linux = price?.linux;
      if (!linux) continue;
      const ondemand = parsePrice(linux.ondemand);
      const spot = parsePrice(linux.spot_min);
      if (ondemand === null && spot === null) continue;

      instances[region] ??= {};
      instances[region][it.instance_type] = {
        vcpu: it.vCPU,
        memory_gb: it.memory,
        ondemand_usd_hour: ondemand,
        spot_usd_hour: spot,
      };
      count++;
    }
  }

  return {
    version: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    source: VANTAGE.aws,
    provider: "aws",
    region_count: Object.keys(instances).length,
    instance_count: count,
    instances,
  };
}

type AzureInstance = {
  pretty_name: string;
  vcpu: number;
  memory: number;
  pricing: Record<
    string,
    Partial<{
      linux: { ondemand?: number | string; spot_min?: number | string };
    }>
  >;
};

function normaliseAzure(raw: AzureInstance[]): NormalisedDataset {
  const instances: NormalisedDataset["instances"] = {};
  let count = 0;

  for (const it of raw) {
    if (!it.pretty_name || !it.pricing) continue;

    for (const [region, price] of Object.entries(it.pricing)) {
      const linux = price?.linux;
      if (!linux) continue;
      const ondemand = parsePrice(linux.ondemand);
      const spot = parsePrice(linux.spot_min);
      if (ondemand === null && spot === null) continue;

      instances[region] ??= {};
      instances[region][it.pretty_name] = {
        vcpu: it.vcpu,
        memory_gb: it.memory,
        ondemand_usd_hour: ondemand,
        spot_usd_hour: spot,
      };
      count++;
    }
  }

  return {
    version: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    source: VANTAGE.azure,
    provider: "azure",
    region_count: Object.keys(instances).length,
    instance_count: count,
    instances,
  };
}

type GcpInstance = {
  instance_type: string;
  vCPU: number;
  memory: number;
  pricing: Record<
    string,
    Partial<{
      linux: { ondemand?: string; spot?: string };
    }>
  >;
};

function normaliseGcp(raw: GcpInstance[]): NormalisedDataset {
  const instances: NormalisedDataset["instances"] = {};
  let count = 0;

  for (const it of raw) {
    if (!it.instance_type || !it.pricing) continue;

    for (const [region, price] of Object.entries(it.pricing)) {
      const linux = price?.linux;
      if (!linux) continue;
      const ondemand = parsePrice(linux.ondemand);
      const spot = parsePrice(linux.spot);
      if (ondemand === null && spot === null) continue;

      instances[region] ??= {};
      instances[region][it.instance_type] = {
        vcpu: it.vCPU,
        memory_gb: it.memory,
        ondemand_usd_hour: ondemand,
        spot_usd_hour: spot,
      };
      count++;
    }
  }

  return {
    version: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    source: VANTAGE.gcp,
    provider: "gcp",
    region_count: Object.keys(instances).length,
    instance_count: count,
    instances,
  };
}

async function run(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const tasks = [
    {
      name: "aws",
      url: VANTAGE.aws,
      normalise: (d: unknown) => normaliseAws(d as AwsInstance[]),
    },
    {
      name: "azure",
      url: VANTAGE.azure,
      normalise: (d: unknown) => normaliseAzure(d as AzureInstance[]),
    },
    {
      name: "gcp",
      url: VANTAGE.gcp,
      normalise: (d: unknown) => normaliseGcp(d as GcpInstance[]),
    },
  ] as const;

  const summaries: Array<{
    provider: string;
    file: string;
    bytes: number;
    regions: number;
    instances: number;
  }> = [];

  for (const t of tasks) {
    process.stdout.write(`[${t.name}] fetching ${t.url}...\n`);
    const raw = await fetchJson<unknown>(t.url);
    const normalised = t.normalise(raw);
    if (normalised.instance_count === 0) {
      throw new Error(`[${t.name}] zero instances after normalisation — refusing to write`);
    }
    const json = JSON.stringify(normalised);
    const file = `${t.name}.json`;
    await writeFile(join(OUT_DIR, file), json);
    summaries.push({
      provider: t.name,
      file,
      bytes: json.length,
      regions: normalised.region_count,
      instances: normalised.instance_count,
    });
    process.stdout.write(
      `[${t.name}] ${normalised.instance_count} prices across ${normalised.region_count} regions, ${(json.length / 1024).toFixed(1)} KB\n`,
    );
  }

  const index = {
    version: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    schema_version: 1,
    source: "https://instances.vantage.sh",
    providers: summaries,
  };
  await writeFile(join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2));
  process.stdout.write(`\nwrote index.json with ${summaries.length} providers\n`);
}

run().catch((err: unknown) => {
  process.stderr.write(`fetch-pricing failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
