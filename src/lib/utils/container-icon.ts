// Maps container image names to devicon icon identifiers
// Uses https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/{name}/{name}-{variant}.svg

const IMAGE_TO_DEVICON: Record<string, string> = {
  // Databases
  postgres: "postgresql",
  postgresql: "postgresql",
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongodb",
  mongodb: "mongodb",
  redis: "redis",
  cassandra: "cassandra",
  couchdb: "couchdb",
  neo4j: "neo4j",
  influxdb: "influxdb",
  cockroachdb: "cockroachdb",

  // Web servers & proxies
  nginx: "nginx",
  apache: "apache",
  httpd: "apache",
  traefik: "traefikproxy",
  envoy: "envoy",
  haproxy: "haproxy",
  caddy: "caddy",

  // Languages & runtimes
  node: "nodejs",
  nodejs: "nodejs",
  python: "python",
  golang: "go",
  go: "go",
  ruby: "ruby",
  php: "php",
  java: "java",
  openjdk: "java",
  eclipse_temurin: "java",
  "eclipse-temurin": "java",
  rust: "rust",
  dotnet: "dotnetcore",
  "mcr.microsoft.com/dotnet": "dotnetcore",
  swift: "swift",
  perl: "perl",
  elixir: "elixir",
  erlang: "erlang",
  scala: "scala",
  kotlin: "kotlin",
  clojure: "clojure",
  haskell: "haskell",
  lua: "lua",
  r: "r",
  dart: "dart",
  deno: "denojs",
  bun: "bun",

  // Frameworks
  django: "django",
  flask: "flask",
  fastapi: "fastapi",
  rails: "rails",
  spring: "spring",
  nextjs: "nextjs",
  nuxt: "nuxtjs",
  laravel: "laravel",
  express: "express",
  nestjs: "nestjs",
  svelte: "svelte",
  react: "react",
  vue: "vuejs",
  angular: "angular",

  // Infrastructure & DevOps
  jenkins: "jenkins",
  gitlab: "gitlab",
  grafana: "grafana",
  prometheus: "prometheus",
  elasticsearch: "elasticsearch",
  kibana: "kibana",
  logstash: "logstash",
  fluentd: "fluentd",
  rabbitmq: "rabbitmq",
  kafka: "apachekafka",
  zookeeper: "apache",
  vault: "vault",
  consul: "consul",
  terraform: "terraform",
  ansible: "ansible",
  puppet: "puppet",
  argocd: "argocd",
  argo: "argocd",

  // Container & orchestration
  docker: "docker",
  podman: "podman",
  kubernetes: "kubernetes",

  // Cloud
  amazonlinux: "amazonwebservices",
  "gcr.io": "googlecloud",
  "mcr.microsoft.com": "azure",

  // OS base images
  ubuntu: "ubuntu",
  debian: "debian",
  alpine: "alpinelinux",
  centos: "centos",
  fedora: "fedora",
  archlinux: "archlinux",
  opensuse: "opensuse",

  // Other
  wordpress: "wordpress",
  drupal: "drupal",
  joomla: "joomla",
  tomcat: "tomcat",
  jetty: "jetty",
  memcached: "memcached",
  minio: "minio",
  sonarqube: "sonarqube",
  sentry: "sentry",
};

// Some icons work better with specific variants
const VARIANT_OVERRIDES: Record<string, string> = {
  nodejs: "plain",
  go: "original-wordmark",
  postgresql: "plain",
  redis: "plain",
  mongodb: "plain",
  mysql: "plain",
  nginx: "original",
  python: "plain",
  java: "plain",
  ruby: "plain",
  php: "plain",
  rust: "original",
  docker: "plain",
  kubernetes: "plain",
  grafana: "plain",
  prometheus: "plain",
  elasticsearch: "plain",
  rabbitmq: "original",
  jenkins: "plain",
  apache: "plain",
  ubuntu: "plain",
  debian: "plain",
  alpine: "original",
  react: "original",
  vuejs: "plain",
  angular: "plain",
  svelte: "plain",
  nextjs: "plain",
  spring: "plain",
  django: "plain",
  flask: "original",
  laravel: "original",
  express: "original",
  argocd: "plain",
  gitlab: "plain",
  terraform: "plain",
};

/**
 * Extract technology name from a container image string.
 * Handles formats like:
 *   - "nginx:latest"
 *   - "docker.io/library/nginx:1.25"
 *   - "registry.k8s.io/kube-proxy:v1.28"
 *   - "ghcr.io/org/myapp:sha-abc123"
 *   - "gcr.io/project/image:tag"
 */
function extractImageBase(image: string): string {
  // Remove tag/digest
  let base = image.split("@")[0].split(":")[0];

  // Get last path segment (the actual image name)
  const parts = base.split("/");
  return parts[parts.length - 1].toLowerCase();
}

const CDN_BASE = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";

const urlCache = new Map<string, string | null>();

export function getContainerIconUrl(image: string): string | null {
  if (!image) return null;
  const base = extractImageBase(image);

  if (urlCache.has(base)) return urlCache.get(base)!;

  // Direct match
  let deviconName = IMAGE_TO_DEVICON[base];

  // Try partial match if no direct hit (only match base inside key, skip short bases to avoid false positives)
  if (!deviconName && base.length > 2) {
    for (const [key, value] of Object.entries(IMAGE_TO_DEVICON)) {
      if (base.includes(key) && key.length > 2) {
        deviconName = value;
        break;
      }
    }
  }

  if (!deviconName) {
    urlCache.set(base, null);
    return null;
  }

  const variant = VARIANT_OVERRIDES[deviconName] ?? "original";
  const url = `${CDN_BASE}/${deviconName}/${deviconName}-${variant}.svg`;
  urlCache.set(base, url);
  return url;
}
