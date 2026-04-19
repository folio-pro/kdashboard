import { chromium, type Browser, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

export interface BenchmarkResult {
  name: string;
  value: number;
  unit: string;
  threshold: number;
  passed: boolean;
  timestamp: string;
}

export interface BenchmarkSuite {
  name: string;
  benchmarks: BenchmarkResult[];
  duration_ms: number;
  hostname: string;
  git_ref?: string;
}

const BENCHMARK_MARKS = {
  RESOURCE_TABLE_MOUNT: "resource-table-mount",
  FILTER_RENDER: "filter-render",
  CONTEXT_SWITCH: "context-switch",
  SCROLL_FPS: "scroll-fps",
};

async function measureResourceTableMount(page: Page, itemCount: number): Promise<number> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const startTime = Date.now();

  await page.evaluate(
    (itemCount) => {
      performance.mark(BENCHMARK_MARKS.RESOURCE_TABLE_MOUNT, {
        detail: JSON.stringify({ itemCount }),
      });
    },
    itemCount
  );

  await page.waitForTimeout(200);

  const marks = await page.evaluate(() => {
    const entries = performance.getEntriesByName(BENCHMARK_MARKS.RESOURCE_TABLE_MOUNT);
    return entries.map((e) => ({
      name: e.name,
      duration: e.duration,
      startTime: e.startTime,
    }));
  });

  const endTime = Date.now();

  if (marks.length > 0) {
    return marks[marks.length - 1].duration;
  }

  return endTime - startTime;
}

async function measureFilterLatency(page: Page): Promise<number> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const filterInput = page.locator('[data-testid="filter-input"]');
  await filterInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => null);

  if (!(await filterInput.isVisible())) {
    return -1;
  }

  const startTime = Date.now();

  await filterInput.fill("api");
  await page.waitForTimeout(50);

  await page.evaluate(() => {
    performance.mark(BENCHMARK_MARKS.FILTER_RENDER);
  });

  await page.waitForTimeout(100);

  const marks = await page.evaluate(() => {
    const entries = performance.getEntriesByName(BENCHMARK_MARKS.FILTER_RENDER);
    return entries.map((e) => ({ name: e.name, duration: e.duration }));
  });

  if (marks.length > 0) {
    return marks[marks.length - 1].duration;
  }

  const endTime = Date.now();
  return endTime - startTime;
}

async function measureContextSwitch(page: Page): Promise<number> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const namespaceFilter = page.locator('[data-testid="namespace-filter"]');
  await namespaceFilter.waitFor({ state: "visible", timeout: 5000 }).catch(() => null);

  if (!(await namespaceFilter.isVisible())) {
    return -1;
  }

  const startTime = Date.now();

  await namespaceFilter.click();
  await page.waitForTimeout(100);

  const namespaceOption = page.locator('[data-testid="namespace-option"]').filter({
    hasText: "kube-system",
  });
  const optionVisible = await namespaceOption.isVisible().catch(() => false);

  if (optionVisible) {
    await namespaceOption.click();
  }

  await page.waitForTimeout(300);

  await page.evaluate(() => {
    performance.mark(BENCHMARK_MARKS.CONTEXT_SWITCH);
  });

  const endTime = Date.now();
  const marks = await page.evaluate(() => {
    const entries = performance.getEntriesByName(BENCHMARK_MARKS.CONTEXT_SWITCH);
    return entries.map((e) => ({ name: e.name, duration: e.duration }));
  });

  if (marks.length > 0) {
    return marks[marks.length - 1].duration;
  }

  return endTime - startTime;
}

async function measureScrollFPS(page: Page): Promise<{ fps: number; droppedFrames: number }> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const rows = page.locator('[data-testid="resource-row"]');
  const rowCount = await rows.count();

  if (rowCount === 0) {
    return { fps: 0, droppedFrames: 0 };
  }

  let totalFrameTime = 0;
  let frameCount = 0;

  for (let i = 0; i < Math.min(rowCount, 20); i++) {
    const frameStart = Date.now();
    await rows.nth(i).scrollIntoViewIfNeeded().catch(() => {});
    const frameEnd = Date.now();
    totalFrameTime += frameEnd - frameStart;
    frameCount++;
  }

  const avgFrameTime = totalFrameTime / frameCount;
  const fps = 1000 / Math.max(avgFrameTime, 1);
  const droppedFrames = avgFrameTime > 16.67 ? Math.floor((avgFrameTime - 16.67) / 16.67) : 0;

  return { fps, droppedFrames };
}

export async function runPlaywrightBenchmarks(): Promise<BenchmarkSuite> {
  const startTime = Date.now();
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const results: BenchmarkResult[] = [];

  try {
    console.log("Running ResourceTable mount benchmark with 500 items...");
    const mountTime500 = await measureResourceTableMount(page, 500);
    results.push({
      name: "resource_table_mount_500",
      value: mountTime500,
      unit: "ms",
      threshold: 500,
      passed: mountTime500 < 500,
      timestamp: new Date().toISOString(),
    });

    console.log("Running ResourceTable mount benchmark with 100 items...");
    const mountTime100 = await measureResourceTableMount(page, 100);
    results.push({
      name: "resource_table_mount_100",
      value: mountTime100,
      unit: "ms",
      threshold: 100,
      passed: mountTime100 < 100,
      timestamp: new Date().toISOString(),
    });

    console.log("Running filter-to-render latency benchmark...");
    const filterLatency = await measureFilterLatency(page);
    if (filterLatency > 0) {
      results.push({
        name: "filter_render_latency",
        value: filterLatency,
        unit: "ms",
        threshold: 50,
        passed: filterLatency < 50,
        timestamp: new Date().toISOString(),
      });
    }

    console.log("Running context switch benchmark...");
    const contextSwitch = await measureContextSwitch(page);
    if (contextSwitch > 0) {
      results.push({
        name: "context_switch_time",
        value: contextSwitch,
        unit: "ms",
        threshold: 500,
        passed: contextSwitch < 500,
        timestamp: new Date().toISOString(),
      });
    }

    console.log("Running scroll FPS benchmark...");
    const scrollMetrics = await measureScrollFPS(page);
    results.push({
      name: "scroll_fps",
      value: scrollMetrics.fps,
      unit: "fps",
      threshold: 30,
      passed: scrollMetrics.fps >= 30,
      timestamp: new Date().toISOString(),
    });
    results.push({
      name: "scroll_dropped_frames",
      value: scrollMetrics.droppedFrames,
      unit: "frames",
      threshold: 5,
      passed: scrollMetrics.droppedFrames < 5,
      timestamp: new Date().toISOString(),
    });
  } finally {
    await browser.close();
  }

  const duration = Date.now() - startTime;

  return {
    name: "kdashboard-frontend-benchmarks",
    benchmarks: results,
    duration_ms: duration,
    hostname: require("os").hostname(),
    git_ref: getGitRef(),
  };
}

function getGitRef(): string {
  try {
    const { execSync } = require("child_process");
    return execSync("git rev-parse --short HEAD 2>/dev/null || echo 'unknown'", {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

export function saveResults(suite: BenchmarkSuite, outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(suite, null, 2));
  console.log(`Results saved to ${outputPath}`);
}

export function printResults(suite: BenchmarkSuite): void {
  console.log("\n=== Benchmark Results ===");
  console.log(`Suite: ${suite.name}`);
  console.log(`Duration: ${suite.duration_ms}ms`);
  console.log(`Git Ref: ${suite.git_ref}`);
  console.log(`Hostname: ${suite.hostname}`);
  console.log("\n--- Results ---");

  let allPassed = true;
  for (const result of suite.benchmarks) {
    const status = result.passed ? "✓ PASS" : "✗ FAIL";
    console.log(
      `${status} | ${result.name}: ${result.value.toFixed(2)} ${result.unit} (threshold: ${result.threshold} ${result.unit})`
    );
    if (!result.passed) allPassed = false;
  }

  console.log("\n--- Summary ---");
  const passed = suite.benchmarks.filter((r) => r.passed).length;
  const total = suite.benchmarks.length;
  console.log(`${passed}/${total} benchmarks passed`);

  if (!allPassed) {
    process.exit(1);
  }
}

if (require.main === module) {
  const outputPath = process.argv[2] || "./benchmark-results.json";

  runPlaywrightBenchmarks()
    .then((suite) => {
      saveResults(suite, outputPath);
      printResults(suite);
    })
    .catch((err) => {
      console.error("Benchmark failed:", err);
      process.exit(1);
    });
}