/**
 * Context icons using Devicons CDN (same source as container-icon.ts).
 */

const CDN_BASE = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";

export interface ContextIcon {
  id: string;
  label: string;
  category: "cloud" | "infra" | "env" | "generic";
}

// Map devicon id -> variant. Only entries that differ from "original" fallback.
// Verified all URLs return 200 from cdn.jsdelivr.net/gh/devicons/devicon@latest
const VARIANT_OVERRIDES: Record<string, string> = {
  amazonwebservices: "original-wordmark",
  googlecloud: "plain",
  azure: "plain",
  cloudflare: "plain",
  heroku: "plain",
  netlify: "plain",
  kubernetes: "plain",
  docker: "plain",
  argocd: "plain",
  terraform: "plain",
  ansible: "plain",
  grafana: "plain",
  jenkins: "plain",
  gitlab: "plain",
  apache: "plain",
  redis: "plain",
  postgresql: "plain",
  mongodb: "plain",
  elasticsearch: "plain",
  linux: "plain",
  ubuntu: "plain",
  debian: "plain",
  centos: "plain",
  fedora: "plain",
  archlinux: "plain",
  nodejs: "plain",
  python: "plain",
  go: "original-wordmark",
  java: "plain",
};

export const CONTEXT_ICONS: ContextIcon[] = [
  // Cloud
  { id: "amazonwebservices", label: "AWS", category: "cloud" },
  { id: "googlecloud", label: "Google Cloud", category: "cloud" },
  { id: "azure", label: "Azure", category: "cloud" },
  { id: "digitalocean", label: "DigitalOcean", category: "cloud" },
  { id: "cloudflare", label: "Cloudflare", category: "cloud" },
  { id: "heroku", label: "Heroku", category: "cloud" },
  { id: "vercel", label: "Vercel", category: "cloud" },
  { id: "netlify", label: "Netlify", category: "cloud" },

  // Infrastructure
  { id: "kubernetes", label: "Kubernetes", category: "infra" },
  { id: "docker", label: "Docker", category: "infra" },
  { id: "argocd", label: "Argo CD", category: "infra" },
  { id: "terraform", label: "Terraform", category: "infra" },
  { id: "ansible", label: "Ansible", category: "infra" },
  { id: "prometheus", label: "Prometheus", category: "infra" },
  { id: "grafana", label: "Grafana", category: "infra" },
  { id: "jenkins", label: "Jenkins", category: "infra" },
  { id: "gitlab", label: "GitLab", category: "infra" },
  { id: "github", label: "GitHub", category: "infra" },
  { id: "nginx", label: "Nginx", category: "infra" },
  { id: "apache", label: "Apache", category: "infra" },
  { id: "redis", label: "Redis", category: "infra" },
  { id: "postgresql", label: "PostgreSQL", category: "infra" },
  { id: "mongodb", label: "MongoDB", category: "infra" },
  { id: "mysql", label: "MySQL", category: "infra" },
  { id: "elasticsearch", label: "Elasticsearch", category: "infra" },
  { id: "rabbitmq", label: "RabbitMQ", category: "infra" },
  { id: "consul", label: "Consul", category: "infra" },
  { id: "vault", label: "Vault", category: "infra" },
  { id: "rancher", label: "Rancher", category: "infra" },

  // Environments (OS / platforms)
  { id: "linux", label: "Linux", category: "env" },
  { id: "ubuntu", label: "Ubuntu", category: "env" },
  { id: "debian", label: "Debian", category: "env" },
  { id: "centos", label: "CentOS", category: "env" },
  { id: "fedora", label: "Fedora", category: "env" },
  { id: "archlinux", label: "Arch Linux", category: "env" },
  { id: "raspberrypi", label: "Raspberry Pi", category: "env" },

  // Generic (languages, useful for project-specific clusters)
  { id: "nodejs", label: "Node.js", category: "generic" },
  { id: "python", label: "Python", category: "generic" },
  { id: "go", label: "Go", category: "generic" },
  { id: "java", label: "Java", category: "generic" },
  { id: "rust", label: "Rust", category: "generic" },
];

const iconMap = new Map<string, ContextIcon>(CONTEXT_ICONS.map((icon) => [icon.id, icon]));

export function getIconById(id: string): ContextIcon | undefined {
  return iconMap.get(id);
}

export const iconsByCategory: Record<ContextIcon["category"], ContextIcon[]> = CONTEXT_ICONS.reduce(
  (acc, icon) => {
    (acc[icon.category] ??= []).push(icon);
    return acc;
  },
  {} as Record<ContextIcon["category"], ContextIcon[]>,
);

export function getIconUrl(deviconId: string): string {
  const variant = VARIANT_OVERRIDES[deviconId] ?? "original";
  return `${CDN_BASE}/${deviconId}/${deviconId}-${variant}.svg`;
}

/**
 * Fetch an SVG from devicons CDN, strip outer <svg> wrapper,
 * and replace all fill/stroke colors with currentColor so it
 * inherits from the parent CSS color.
 */
const svgCache = new Map<string, string | null>();

export async function fetchMonochromeIcon(deviconId: string): Promise<string | null> {
  if (svgCache.has(deviconId)) return svgCache.get(deviconId)!;

  try {
    const url = getIconUrl(deviconId);
    const res = await fetch(url);
    if (!res.ok) { svgCache.set(deviconId, null); return null; }

    let text = await res.text();

    // Remove any embedded <style> blocks (some devicons use CSS classes with hardcoded colors)
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

    // Replace all fill="..." and stroke="..." with currentColor (except "none")
    text = text.replace(/fill="(?!none)[^"]*"/g, 'fill="currentColor"');
    text = text.replace(/stroke="(?!none)[^"]*"/g, 'stroke="currentColor"');

    // Handle inline style attributes with fill/stroke
    text = text.replace(/style="[^"]*"/g, (match) => {
      return match
        .replace(/fill:\s*(?!none)[^;"]+/g, "fill: currentColor")
        .replace(/stroke:\s*(?!none)[^;"]+/g, "stroke: currentColor");
    });

    // Add fill="currentColor" to <path>, <circle>, <rect>, <polygon>, <ellipse> that have NO fill attribute
    // (SVG default fill is black, we need to override it)
    text = text.replace(
      /<(path|circle|rect|polygon|ellipse|line|polyline)(?![^>]*\bfill\b)([^>]*?)(\s*\/?>)/gi,
      '<$1 fill="currentColor"$2$3',
    );

    // Set fill="currentColor" on the root <svg> tag as a fallback
    text = text.replace(/<svg([^>]*)>/, (match, attrs) => {
      if (/\bfill\b/.test(attrs)) {
        return match;
      }
      return `<svg fill="currentColor"${attrs}>`;
    });

    svgCache.set(deviconId, text);
    return text;
  } catch {
    svgCache.set(deviconId, null);
    return null;
  }
}
