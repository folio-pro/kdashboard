// Settings that handler modules need at request time, held as plain state.
//
// The settings file itself lives in handlers/app.ts, which depends on Electron
// (userData path). Handlers that only need a value — not the file — read it
// here instead, so they stay importable outside Electron (integration tests,
// scripts) and so no handler module imports another.
//
// app.ts pushes into this on load and on every save_settings.

let prometheusUrl = '';

/** Set the Prometheus base URL (trailing slash trimmed). '' disables it. */
export function setPrometheusUrl(url: string | null | undefined): void {
  const trimmed = (url ?? '').trim().replace(/\/$/, '');
  prometheusUrl = trimmed;
}

/** Configured Prometheus base URL, or undefined when none is set. */
export function getPrometheusUrl(): string | undefined {
  return prometheusUrl === '' ? undefined : prometheusUrl;
}
