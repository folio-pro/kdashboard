use ui::container_icon::detect_technology;

#[test]
fn test_detect_known_image() {
    let tech = detect_technology("nginx:1.25-alpine").unwrap();
    assert_eq!(tech.name, "nginx");
}

#[test]
fn test_detect_registry_prefix() {
    let tech = detect_technology("docker.io/library/redis:7").unwrap();
    assert_eq!(tech.name, "redis");
}

#[test]
fn test_detect_unknown_image() {
    assert!(detect_technology("my-custom-app:latest").is_none());
}

#[test]
fn test_detect_postgres_variant() {
    let tech = detect_technology("postgres:16").unwrap();
    assert_eq!(tech.name, "postgres");
}

#[test]
fn test_detect_with_digest() {
    let tech = detect_technology("python@sha256:abc123").unwrap();
    assert_eq!(tech.name, "python");
}

#[test]
fn test_detect_eclipse_temurin() {
    let tech = detect_technology("eclipse-temurin:21-jre").unwrap();
    assert_eq!(tech.name, "eclipse-temurin");
}
