# KDashboard UI/UX Comprehensive Review

**Date:** February 22, 2026
**Scope:** Full application — workspace shell, resource views, terminal, logs, visual design system, app flow
**Framework:** GPUI (GPU-accelerated Rust UI) + kube-rs

---

## Executive Summary

KDashboard has a **solid architectural foundation** with clean separation of concerns, professional theme support (10 themes), and strong K8s integration patterns. However, the review identified **87 specific issues** across 5 domains, including critical accessibility gaps, missing user feedback patterns, and incomplete features. This document organizes all findings by priority and domain.

---

## Critical Issues (P0) — Fix Immediately

| # | Issue | Domain | File | Impact |
|---|-------|--------|------|--------|
| 1 | **Shell selection UI has no effect** — dropdown updates state but value is never passed to `start_terminal_session()` | Terminal | `terminal_view.rs:131,457` | Users think they can choose shell, but it always uses `/bin/bash` |
| 2 | **No confirmation before destructive actions** — delete triggers immediately, no undo | Workspace | `app_view.rs:202-211` | Accidental resource deletion |
| 3 | **AI Assistant is non-functional placeholder** — framework exists but no actual API calls | App Flow | `ai_chat_panel.rs` | Misleading feature, no API key setup |
| 4 | **No "last updated" or refresh indicator** — users have no way to know data freshness | App Flow | `app_state.rs` | Decisions made on stale data |
| 5 | **Warning foreground contrast violation** — black text on colored warning backgrounds fails WCAG AA | Design | `theme.rs:499-501` | Hard to read warning text |
| 6 | **Primary color contrast fails in light themes** — GitHubLight, EverforestLight below 4.5:1 ratio | Design | `theme.rs:276-295` | Low contrast on buttons and links |
| 7 | **No focus indicators for keyboard navigation** — no focus ring on any interactive element | Workspace | `sidebar.rs, app_view.rs` | App unusable for keyboard-only users |
| 8 | **Secrets not masked by default** — secret data shown in plain text in details panel | Resources | `table.rs:2089-2118` | Security risk if screen shared |

---

## High Priority Issues (P1)

### Workspace Shell

| # | Issue | File:Line | Recommendation |
|---|-------|-----------|----------------|
| 9 | No visual loading state during context switch — users may click repeatedly | `sidebar.rs:271-273` | Add spinner overlay on clicked cluster button |
| 10 | Loading state replaces table with spinner — stale data hidden during refresh | `app_view.rs:1111-1156` | Keep old data visible, show progress bar above table |
| 11 | No cancel button for slow loads — user stuck if API hangs | `app_view.rs:1119-1154` | Add cancel button + timeout indicator |
| 12 | Error messages too subtle — 10% opacity background barely visible | `app_view.rs:1095-1108` | Increase to 15-20% opacity, add left border accent + icon |
| 13 | No toast notifications for success — user infers success from absence of error | All | Implement toast notification system (success, warning, error, info) |
| 14 | Right panel overlay has no visible close button at shell level | `app_view.rs:991-999` | Add persistent close button + ESC key + backdrop overlay |
| 15 | Unimplemented "Create" button shown but grayed out — confusing | `app_view.rs:1374-1383` | Remove entirely or mark "Coming soon" clearly |

### Resource Views & Table

| # | Issue | File:Line | Recommendation |
|---|-------|-----------|----------------|
| 16 | Search only filters by name — can't search by namespace, status, labels | `app_state.rs:100-120` | Add advanced search: `name:x namespace:y status:z` |
| 17 | Search input not always visible — requires `/` keybinding | `header.rs:112-156` | Add persistent search bar in header |
| 18 | No search result count — user doesn't know how many items match | Header | Show "5 of 42 pods matching 'api'" |
| 19 | Sort icons extremely faint — `text_muted.opacity(0.5)` | `table.rs:1275-1280` | Show sort icon at 80%+ opacity; highlight on hover |
| 20 | No skeleton/progressive loading — blank then populated | Resources | Show skeleton rows (5-10 placeholders) during initial load |
| 21 | Empty state too generic — doesn't distinguish "no resources" from "filter filtered all" | `table.rs:818-840` | Show contextual messages + "Clear filters" button |
| 22 | No delete confirmation in pod details — immediate deletion | `pod_details.rs:352-387` | Show confirmation dialog |
| 23 | Column widths not persisted — reset on reload | `table.rs:1325-1371` | Save widths per resource type |
| 24 | Resize handle hard to find (8px) | `table.rs:1337-1345` | Increase hover width to 16px + show ":::" visual |

### Terminal

| # | Issue | File:Line | Recommendation |
|---|-------|-----------|----------------|
| 25 | No "Jump to Latest" button when scrolled up | `terminal_view.rs:844` | Show sticky "Scroll to latest" button when scrolled up |
| 26 | Disconnection reason not shown — only status badge changes | `terminal_view.rs:202` | Show reason message ("Connection lost", "Shell exited") in terminal area |
| 27 | Container switch has no feedback — blank terminal, unclear which container | `terminal_view.rs:421` | Show "Connecting to container: X..." in header |
| 28 | No keyboard shortcuts for zoom — missing Ctrl+=/-/0 | Terminal | Add standard terminal zoom shortcuts |
| 29 | No copy/paste support | Terminal | Implement Ctrl+Shift+C/V or selection-based copy |

### Logs

| # | Issue | File:Line | Recommendation |
|---|-------|-----------|----------------|
| 30 | No multiline log support — stack traces split into 10+ entries | `pod_logs_view.rs:242-271` | Detect continuation lines (whitespace prefix) and group |
| 31 | Auto-scroll conflated with streaming toggle — confusing UX | `pod_logs_view.rs:725-769` | Separate into "Stream" (fetch) and "Auto-scroll" (view) toggles |
| 32 | Log fetch timeout too short (10s) | `pod_logs_view.rs:450` | Increase to 20s or add configurable timeout |
| 33 | No retry button for failed log loads | `pod_logs_view.rs:1299-1310` | Add "Retry" button alongside error message |
| 34 | Connection dropped during streaming is silent | Logs | Show "Stream disconnected" indicator + reconnect option |
| 35 | No keyboard navigation in log modal — must click X to close | `pod_logs_view.rs:1410-1527` | Add ESC to close + Prev/Next navigation |
| 36 | Modal fixed 560px width — too wide on narrow screens | `pod_logs_view.rs:1415` | Make responsive (max 50% viewport) |

### Design System

| # | Issue | File:Line | Recommendation |
|---|-------|-----------|----------------|
| 37 | Button text size (12px) doesn't match theme font_size (13px) | `buttons.rs:6-12` | Align all sizes to theme values |
| 38 | Button vertical padding too tight (6px) | `buttons.rs:7` | Increase to 8-10px for touchability |
| 39 | Hover states use opacity only, not color shifts | `buttons.rs:50,112` | Use `colors.primary_hover` and `colors.selection_hover` |
| 40 | Spacing values inconsistent — py(10.0), gap(6.0) break 4px scale | Multiple | Adopt 8px base scale with named tokens |
| 41 | Hard-coded font sizes coexist with theme values | `table.rs:1023,938` | Use theme-based sizing throughout |
| 42 | Duplicate icon names — Pods/Box, Services/Network map to same SVG | `icon.rs:4-59` | Remove generic aliases, keep K8s-specific names |
| 43 | Missing pod status icons (CrashLoopBackOff, ImagePullBackOff, etc.) | `table.rs:16-43` | Expand StatusType enum + add dedicated icons |

### App Flow

| # | Issue | File:Line | Recommendation |
|---|-------|-----------|----------------|
| 44 | No context switch confirmation — accidental production changes possible | `sidebar.rs:271` | Add modal: "Switch to context X? This will reload all resources" |
| 45 | Kubeconfig modified silently on context switch | `client.rs:81-102` | Add setting: "Sync context switch to kubeconfig" (opt-in) |
| 46 | No first-run experience — new users get no guidance | `main.rs:205` | Detect first run, show 2-3 slide onboarding modal |
| 47 | Namespace validation fails silently — saved ns deleted in cluster | `main.rs:361-373` | Show toast: "Your saved namespace 'X' was deleted. Switched to 'default'" |
| 48 | Watch errors are silent — data may be stale without indication | `resource_loader.rs:74-78` | Add watch health indicator (green/yellow/red) in header |
| 49 | No manual refresh button | App Flow | Add refresh icon in header next to namespace selector |
| 50 | No connection timeout — "Connecting..." shown indefinitely | `main.rs:317-523` | Add 10-15s timeout + "Connection timed out" error |

---

## Medium Priority Issues (P2)

### Navigation & Interaction

| # | Issue | Description |
|---|-------|-------------|
| 51 | Details require double-click — inconsistent with desktop conventions (single-click select) |
| 52 | No back/breadcrumb navigation when navigating Deployment → Pod |
| 53 | No view state persistence — scroll position resets when switching resource types |
| 54 | Port Forwards navigation inconsistent — replaces header and table entirely |
| 55 | Sidebar section toggle not discoverable — no clear affordance that sections are collapsible |
| 56 | No keyboard navigation within sidebar — no arrow key support |
| 57 | Namespace selector unclear for cluster-wide resources (Nodes, Namespaces) |
| 58 | "All Namespaces" shows no count of included namespaces |
| 59 | Breadcrumb navigation non-interactive — clicking goes back but doesn't filter |
| 60 | Search input no visible clear (X) button |

### Data Presentation

| # | Issue | Description |
|---|-------|-------------|
| 61 | Status label "Ready" mapped to "Running" is confusing for jobs that show "Complete" |
| 62 | Age shows "0s" for freshly created resources — confusing |
| 63 | Labels/annotations truncate without full-value tooltip on hover |
| 64 | HPA metrics column extremely dense: "CPU:45%/80% Mem:512Mi/1Gi" |
| 65 | Ingress multi-host display truncates without indication |
| 66 | No JSON log format detection — structured logs shown as Debug level |
| 67 | Multi-select rows not visually distinct enough — no "primary" row indicator |
| 68 | Bulk action dialog is modal — can't see which resources are selected |
| 69 | Pod port forward input field is unlabeled |
| 70 | Events card in details lacks timestamp prominence and filtering |

### Terminal & Logs Polish

| # | Issue | Description |
|---|-------|-------------|
| 71 | Terminal font size not persisted — resets to 14px on reopen |
| 72 | Hardcoded prompt display `root@<pod>:/app#` doesn't match actual container prompt |
| 73 | Reconnect button clickable while already Connected — no guard |
| 74 | Disconnected terminal still renders interactive-looking grid |
| 75 | No initial connection timeout for terminal |
| 76 | Log search input limited to 250px max width |
| 77 | Wrapped log layout not virtualized — 500+ matching lines rendered in DOM |
| 78 | Container switch shows old logs until new ones arrive |

### Responsive Design

| # | Issue | Description |
|---|-------|-------------|
| 79 | Sidebar 248px is 31% of 800px minimum window — too wide on small screens |
| 80 | Header search box fixed 300px + namespace + settings doesn't fit on small viewports |
| 81 | Metric cards and page header don't stack vertically on narrow screens |
| 82 | Fixed 24px content padding too large below 1000px viewport |
| 83 | Log modal 560px width takes 55% of 1024px laptop screen |

### Accessibility

| # | Issue | Description |
|---|-------|-------------|
| 84 | `text_muted` likely fails WCAG AA for small text (< 14px needs 7:1 contrast) |
| 85 | Color-only encoding on cluster rail — single letter + color insufficient for color blind users |
| 86 | No ARIA attributes / semantic structure (GPUI limitation) |
| 87 | `status_badge_opacity` field defined (0.12) but never used — dead code |

---

## Recommendations by Phase

### Phase 1: Critical Fixes (Sprint 1-2)

1. **Fix shell selection** — pass `selected_shell` to `start_terminal_session()`
2. **Add confirmation dialogs** for all destructive actions (delete, bulk delete, scale to 0)
3. **Mask secrets by default** — show `••••••` with "Reveal" button
4. **Audit and fix color contrast** — ensure WCAG AA (4.5:1) for all theme combinations
5. **Add focus indicators** — 2px ring on all interactive elements
6. **Add toast notification system** — success, warning, error, info with auto-dismiss
7. **Add manual refresh button** + "Last updated: Xs ago" in header
8. **Complete or remove AI Assistant** — add API key setup or show "Coming soon" badge

### Phase 2: UX Polish (Sprint 3-4)

9. **Implement keyboard navigation** in sidebar (arrow keys, Enter, Escape)
10. **Add breadcrumb navigation** — "Pods > nginx-abc123 > Details"
11. **Separate streaming from auto-scroll** in logs
12. **Add multiline log grouping** — detect stack traces and continuation lines
13. **Show skeleton loading** — 5-10 placeholder rows during data fetch
14. **Improve empty states** — contextual messages per resource type + quick actions
15. **Add context switch confirmation** — warn on production-like contexts
16. **Responsive sidebar** — auto-collapse below 900px, responsive padding

### Phase 3: Power Features (Sprint 5+)

17. **Advanced search** — filter by name, namespace, status, labels
18. **Searchable command palette** — Ctrl+K with descriptions
19. **First-run onboarding** — detect new users, show intro modal
20. **Table virtualization** — handle 1000+ rows without stall
21. **Expand StatusType** — CrashLoopBackOff, ImagePullBackOff, OOMKilled, Evicted
22. **Resource utilization visualization** — color-coded CPU/memory bars
23. **Watch health indicator** — green/yellow/red per resource type
24. **Help panel** — keyboard shortcuts, workflow guides, searchable commands

---

## Architecture Observations

### Strengths
- Clean crate separation (8 crates, clear dependency graph)
- Global AppState pattern works well for reactive GPUI updates
- Watch/polling architecture is a solid foundation for real-time data
- Command bar with K9s-like aliases is excellent for power users
- 10 curated themes with dual font family approach (Inter + JetBrains Mono)
- Comprehensive error recovery dialog for connection failures

### Areas for Improvement
- **AppState is monolithic** (~135 fields) — consider splitting into sub-states
- **Error handling via string matching** — use structured `K8sError` enum instead
- **Render functions are very long** — `app_view.rs` exceeds 1300 lines, extract components
- **No tests for UI navigation flows** — consider snapshot testing
- **Dead code** — `status_badge_opacity`, unused icon aliases should be cleaned up
- **100ms poll interval** in resource_loader may cause unnecessary re-renders — debounce to 500ms

---

## Summary

| Severity | Count | Key Areas |
|----------|-------|-----------|
| **P0 Critical** | 8 | Shell selection broken, no delete confirmation, secrets exposed, contrast failures |
| **P1 High** | 42 | Missing feedback, poor loading states, terminal/logs gaps, navigation friction |
| **P2 Medium** | 37 | Responsive design, accessibility, data presentation polish, performance |
| **Total** | 87 | |

The most impactful improvements are: (1) fixing broken features (shell selection, AI assistant), (2) adding user feedback mechanisms (toasts, loading indicators, confirmations), and (3) addressing accessibility gaps (contrast, focus, keyboard navigation). These changes would elevate KDashboard from a strong technical prototype to a production-ready Kubernetes dashboard.
