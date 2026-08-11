/**
 * Short badge text for a kube context, for the cluster rail avatars.
 *
 * The rail used `name.charAt(0)`, which on a real kubeconfig collapses into
 * near-useless noise — a rail reading `D G G K K O O P P P P` distinguishes
 * eleven clusters by colour alone. Real context names are segmented
 * (`prod-eu-west`, `ovh_k8s`, `arn:aws:eks:...:cluster/staging`), so taking
 * one character per segment recovers most of that signal in the same space.
 */
export function contextInitials(name: string): string {
  if (!name) return "?";

  // ARN-style / path-style names: the trailing path segment is the cluster.
  const tail = name.split("/").pop() ?? name;

  const allSegments = tail.split(/[^A-Za-z0-9]+/).filter(Boolean);

  // Segments that carry no identity — nearly every context has them, so they
  // can only dilute the badge.
  const meaningful = allSegments.filter(
    (s) => !/^(k8s|kube|kubernetes|cluster|context|admin|default)$/i.test(s),
  );
  const segments = meaningful.length > 0 ? meaningful : allSegments;

  // Nothing alphanumeric to work with at all.
  if (segments.length === 0) return "?";

  if (segments.length === 1) {
    // Single segment: two characters beat one, and a trailing digit is usually
    // the distinguishing part ("prod2" -> "P2").
    const only = segments[0];
    const digit = only.match(/\d+$/)?.[0];
    return (digit ? only[0] + digit[0] : only.slice(0, 2)).toUpperCase();
  }

  return segments
    .slice(0, 3)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
}
