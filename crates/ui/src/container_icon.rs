use gpui::*;

use crate::{Icon, IconName};
use crate::theme::Theme;

/// A known container technology with its SVG icon path.
pub struct Technology {
    pub name: &'static str,
    pub svg_path: &'static str,
}

/// Attempt to detect a known technology from a container image string.
///
/// Extracts the base image name (last path segment, minus tag/digest) and
/// matches it against a curated list of devicon-supported technologies.
pub fn detect_technology(image: &str) -> Option<&'static Technology> {
    // Extract base name: "registry.io/org/nginx:1.25" → "nginx"
    let base = image.rsplit('/').next().unwrap_or(image);
    let name = base.split(':').next().unwrap_or(base);
    let name = name.split('@').next().unwrap_or(name); // handle digest refs

    lookup_technology(name)
}

fn lookup_technology(name: &str) -> Option<&'static Technology> {
    let lower = name.to_ascii_lowercase();
    TECHNOLOGIES.iter().find(|t| {
        t.name == lower
            || lower.starts_with(t.name)
            || lower.contains(t.name)
    })
}

/// Render a container icon for the given image. Shows a technology-specific SVG
/// when the image matches a known technology, otherwise falls back to the generic Box icon.
/// Uses `img()` instead of `svg()` to preserve the original multi-color SVG rendering.
pub fn container_icon(image: &str, theme: &Theme) -> AnyElement {
    let colors = &theme.colors;

    if let Some(tech) = detect_technology(image) {
        div()
            .flex_shrink_0()
            .size(px(36.0))
            .rounded(theme.border_radius_md)
            .bg(colors.surface)
            .border_1()
            .border_color(colors.border)
            .flex()
            .items_center()
            .justify_center()
            .child(img(tech.svg_path).size(px(20.0)))
            .into_any_element()
    } else {
        div()
            .flex_shrink_0()
            .size(px(36.0))
            .rounded(theme.border_radius_md)
            .bg(colors.primary)
            .flex()
            .items_center()
            .justify_center()
            .child(
                Icon::new(IconName::Box)
                    .size(px(18.0))
                    .color(colors.background),
            )
            .into_any_element()
    }
}

/// Render a small container icon (22px) for use in compact layouts like table rows.
/// Uses a light surface background with the original multi-color SVG.
pub fn container_icon_small(image: &str, theme: &Theme) -> AnyElement {
    let colors = &theme.colors;

    if let Some(tech) = detect_technology(image) {
        div()
            .flex_shrink_0()
            .size(px(22.0))
            .rounded(theme.border_radius_sm)
            .bg(colors.surface)
            .border_1()
            .border_color(colors.border)
            .flex()
            .items_center()
            .justify_center()
            .child(img(tech.svg_path).size(px(14.0)))
            .into_any_element()
    } else {
        div()
            .flex_shrink_0()
            .size(px(22.0))
            .rounded(theme.border_radius_sm)
            .bg(colors.surface)
            .border_1()
            .border_color(colors.border)
            .flex()
            .items_center()
            .justify_center()
            .child(
                Icon::new(IconName::Box)
                    .size(px(12.0))
                    .color(colors.text_muted),
            )
            .into_any_element()
    }
}

// Technology database — SVG icon paths (loaded from assets)
static TECHNOLOGIES: &[Technology] = &[
    Technology { name: "nginx", svg_path: "icons/tech/nginx.svg" },
    Technology { name: "redis", svg_path: "icons/tech/redis.svg" },
    Technology { name: "postgres", svg_path: "icons/tech/postgresql.svg" },
    Technology { name: "mysql", svg_path: "icons/tech/mysql.svg" },
    Technology { name: "mongo", svg_path: "icons/tech/mongodb.svg" },
    Technology { name: "python", svg_path: "icons/tech/python.svg" },
    Technology { name: "node", svg_path: "icons/tech/nodejs.svg" },
    Technology { name: "golang", svg_path: "icons/tech/go.svg" },
    Technology { name: "go", svg_path: "icons/tech/go.svg" },
    Technology { name: "docker", svg_path: "icons/tech/docker.svg" },
    Technology { name: "kubernetes", svg_path: "icons/tech/kubernetes.svg" },
    Technology { name: "k8s", svg_path: "icons/tech/kubernetes.svg" },
    Technology { name: "java", svg_path: "icons/tech/java.svg" },
    Technology { name: "openjdk", svg_path: "icons/tech/java.svg" },
    Technology { name: "eclipse-temurin", svg_path: "icons/tech/java.svg" },
    Technology { name: "rust", svg_path: "icons/tech/rust.svg" },
    Technology { name: "php", svg_path: "icons/tech/php.svg" },
    Technology { name: "fpm", svg_path: "icons/tech/php.svg" },
    Technology { name: "ruby", svg_path: "icons/tech/ruby.svg" },
    Technology { name: "react", svg_path: "icons/tech/react.svg" },
    Technology { name: "typescript", svg_path: "icons/tech/typescript.svg" },
    Technology { name: "apache", svg_path: "icons/tech/apache.svg" },
    Technology { name: "httpd", svg_path: "icons/tech/apache.svg" },
    Technology { name: "tomcat", svg_path: "icons/tech/tomcat.svg" },
    Technology { name: "rabbitmq", svg_path: "icons/tech/rabbitmq.svg" },
    Technology { name: "kafka", svg_path: "icons/tech/kafka.svg" },
    Technology { name: "elasticsearch", svg_path: "icons/tech/elasticsearch.svg" },
    Technology { name: "elastic", svg_path: "icons/tech/elasticsearch.svg" },
    Technology { name: "grafana", svg_path: "icons/tech/grafana.svg" },
    Technology { name: "prometheus", svg_path: "icons/tech/prometheus.svg" },
    Technology { name: "jenkins", svg_path: "icons/tech/jenkins.svg" },
    Technology { name: "terraform", svg_path: "icons/tech/terraform.svg" },
    Technology { name: "consul", svg_path: "icons/tech/consul.svg" },
    Technology { name: "cassandra", svg_path: "icons/tech/cassandra.svg" },
    Technology { name: "mariadb", svg_path: "icons/tech/mariadb.svg" },
];
