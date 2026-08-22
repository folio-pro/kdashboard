// Copy for the pod overview's attention block, built from podProblem(). Pure
// so the wording ("Container api is crash-looping · last exit code 1 · Error
// · 3m ago") is unit-tested rather than eyeballed.

import type { PodProblem } from "$lib/utils/pod-status";
import { formatAge } from "$lib/utils/age";

export interface PodProblemCopy {
  tone: "error" | "warning";
  title: string;
  lines: string[];
}

const CRASH = /crashloop/i;
const IMAGE = /imagepull|errimage|invalidimagename/i;
const CONFIG = /createcontainerconfigerror|createcontainererror/i;

export function podProblemCopy(problem: PodProblem, now: number = Date.now()): PodProblemCopy {
  void now;
  const lines: string[] = [];

  if (!problem.container) {
    // The scheduler could not place the pod.
    lines.push(problem.message ? problem.message : `Reason: ${problem.reason}`);
    return { tone: "warning", title: "Pod cannot be scheduled", lines };
  }

  const who = `${problem.init ? "Init container" : "Container"} ${problem.container}`;
  let title: string;
  let tone: PodProblemCopy["tone"] = "error";
  if (CRASH.test(problem.reason)) title = `${who} is crash-looping`;
  else if (IMAGE.test(problem.reason)) title = `${who} cannot pull its image`;
  else if (CONFIG.test(problem.reason)) title = `${who} cannot be created`;
  else if (/oom/i.test(problem.reason)) title = `${who} was OOM-killed`;
  else title = `${who} failed: ${problem.reason}`;

  if (problem.exitCode !== undefined || problem.lastReason) {
    const parts = [`Last exit: code ${problem.exitCode ?? "?"}`];
    if (problem.lastReason) parts.push(problem.lastReason);
    if (problem.lastFinishedAt) parts.push(`${formatAge(problem.lastFinishedAt)} ago`);
    lines.push(parts.join(" · "));
  }
  if (problem.restartCount > 0) {
    lines.push(`${problem.restartCount} restart${problem.restartCount === 1 ? "" : "s"}`);
  }
  if (problem.message) lines.push(problem.message.trim());

  return { tone, title, lines };
}
