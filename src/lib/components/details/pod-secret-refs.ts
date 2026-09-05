// Every Secret a Pod spec can name, in one place. The related-resources card
// used to list the ConfigMap a pod mounted but not the Secret it read through
// `env[].valueFrom.secretKeyRef` or pulled its image with, which is where the
// interesting ones tend to be.

import type { Resource } from "$lib/types";

type Obj = Record<string, unknown>;

function asList(value: unknown): Obj[] {
  return Array.isArray(value) ? (value as Obj[]) : [];
}

function nameOf(value: unknown): string | null {
  const name = (value as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name ? name : null;
}

/**
 * Distinct Secret names referenced by a pod spec, in first-seen order:
 * `imagePullSecrets`, volumes (`secret`, `projected.sources[].secret`),
 * and every container kind's `envFrom[].secretRef` and
 * `env[].valueFrom.secretKeyRef`.
 */
export function podSecretRefs(resource: Resource): string[] {
  const spec = (resource.spec ?? {}) as Obj;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | null) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };

  for (const ref of asList(spec.imagePullSecrets)) add(nameOf(ref));

  for (const vol of asList(spec.volumes)) {
    const secret = vol.secret as { secretName?: unknown } | undefined;
    if (typeof secret?.secretName === "string") add(secret.secretName);
    const projected = vol.projected as { sources?: unknown } | undefined;
    for (const src of asList(projected?.sources)) add(nameOf(src.secret));
  }

  const containers = [
    ...asList(spec.initContainers),
    ...asList(spec.containers),
    ...asList(spec.ephemeralContainers),
  ];
  for (const c of containers) {
    for (const ef of asList(c.envFrom)) add(nameOf(ef.secretRef));
    for (const env of asList(c.env)) {
      const from = env.valueFrom as { secretKeyRef?: unknown } | undefined;
      add(nameOf(from?.secretKeyRef));
    }
  }

  return out;
}
