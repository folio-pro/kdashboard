/**
 * Kubernetes YAML schema definitions for autocompletion and validation.
 * Barrel re-export — all symbols forwarded from focused sub-modules.
 */

export type { SchemaField } from "./k8s-schema-fields.js";
export { K8S_SCHEMAS } from "./k8s-schema-resources.js";
export { KIND_API_VERSIONS, COMMON_ANNOTATIONS, COMMON_LABELS } from "./k8s-schema-metadata.js";
export { resolveSchemaAtPath, getFieldInfo } from "./k8s-schema-resolver.js";
