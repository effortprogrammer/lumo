import {
  type BrowserPageKind,
  type BrowserProgressAssessment,
  type BrowserStateSnapshot,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { type LogBatch } from "../logging/log-batcher.js";

export function enrichBrowserSituation(
  batch: LogBatch,
  now: string,
): LogBatch {
  const recentLogs = batch.recentLogs ?? batch.batch;
  const browserLogs = recentLogs.filter((record) => record.tool === "agent-browser");
  if (browserLogs.length === 0) {
    return batch;
  }

  const browserState = buildBrowserStateSnapshot(browserLogs);
  const browserProgress = buildBrowserProgressAssessment(browserLogs, batch.taskInstruction, now);
  return {
    ...batch,
    browserState,
    browserProgress,
  };
}

export function buildBrowserStateSnapshot(
  browserLogs: ToolExecutionRecord[],
): BrowserStateSnapshot {
  const latest = browserLogs.at(-1);
  const latestWithUrlOrTitle = [...browserLogs].reverse()
    .find((record) => getBrowserUrl(record) || getBrowserTitle(record));
  const url = getBrowserUrl(latestWithUrlOrTitle ?? latest);
  const title = getBrowserTitle(latestWithUrlOrTitle ?? latest);
  const lastMeaningfulChangeAt = [...browserLogs].reverse()
    .find((record) => getBrowserUrl(record) || getBrowserTitle(record))?.timestamp;

  return {
    url,
    title,
    pageKind: classifyBrowserPage(url, title),
    lastAction: latest?.input,
    lastActionAt: latest?.timestamp,
    lastMeaningfulChangeAt,
    extractedTextHints: buildTextHints(latest),
    screenshotRef: latest?.screenshotRef,
    metadata: latest?.metadata,
  };
}

export function buildBrowserProgressAssessment(
  browserLogs: ToolExecutionRecord[],
  taskInstruction: string,
  now: string,
): BrowserProgressAssessment {
  const latest = browserLogs.at(-1);
  const previous = browserLogs.at(-2);
  const stateSnapshot = buildBrowserStateSnapshot(browserLogs);
  const relevance = assessGoalRelevance(taskInstruction, stateSnapshot);

  if (!latest) {
    return {
      state: "unclear",
      goalRelevance: relevance,
      reason: "No browser activity has been recorded yet.",
      summary: "No browser progress has been observed yet.",
      observedAt: now,
    };
  }

  if (latest.status === "error") {
    const failureGuidance = interpretBrowserFailure(latest, stateSnapshot);
    return {
      state: "stalled",
      goalRelevance: relevance,
      reason: failureGuidance.reason,
      summary: failureGuidance.summary,
      recommendedNext: failureGuidance.recommendedNext,
      observedAt: now,
    };
  }

  const latestSignature = buildBrowserProgressSignature(latest);
  const previousSignature = previous ? buildBrowserProgressSignature(previous) : null;
  if (previous && latest.input === previous.input && latestSignature === previousSignature) {
    return {
      state: "stalled",
      goalRelevance: relevance,
      reason: "The browser action repeated without a meaningful page-state change.",
      summary: "The browser appears to be repeating the same step without advancing.",
      recommendedNext: "Change strategy or inspect the current page state before retrying.",
      observedAt: now,
    };
  }

  if (stateSnapshot.url || stateSnapshot.title) {
    return {
      state: "advancing",
      goalRelevance: relevance,
      reason: "The browser state changed and produced new page context.",
      summary: buildProgressSummary(stateSnapshot),
      recommendedNext: "Continue extracting the needed information from the current page.",
      observedAt: now,
    };
  }

  return {
    state: "unclear",
    goalRelevance: relevance,
    reason: "The browser action completed, but no stable page context was extracted yet.",
    summary: "Browser progress is ambiguous because URL/title evidence is missing.",
    recommendedNext: "Capture a snapshot or query the current title/URL before proceeding.",
    observedAt: now,
  };
}

function buildBrowserProgressSignature(record: ToolExecutionRecord): string {
  return [
    getBrowserUrl(record) ?? "",
    getBrowserTitle(record) ?? "",
    record.screenshotRef?.id ?? "",
  ].join("|");
}

function buildProgressSummary(snapshot: BrowserStateSnapshot): string {
  const pageTarget = snapshot.title ?? snapshot.url ?? "the current page";
  return `The browser is currently on ${pageTarget} (${snapshot.pageKind}).`;
}

function buildTextHints(record: ToolExecutionRecord | undefined): string[] | undefined {
  if (!record) {
    return undefined;
  }

  if (typeof record.output === "string") {
    const trimmed = record.output.trim();
    return trimmed.length > 0 ? [trimmed.slice(0, 160)] : undefined;
  }

  const hints = [
    pickString(record.output, ["title", "text", "summary"]),
    pickString(record.output, ["message"]),
  ].filter((value): value is string => Boolean(value));
  return hints.length > 0 ? hints : undefined;
}

function classifyBrowserPage(
  url: string | undefined,
  title: string | undefined,
): BrowserPageKind {
  const combined = `${url ?? ""} ${title ?? ""}`.toLowerCase();
  if (combined.includes("google.com/search") || /\bsearch\b/.test(combined)) {
    return "search_results";
  }
  if (/linkedin\.com\/jobs\/view|\/jobs\/view\//.test(combined) || /\bjob detail\b/.test(combined)) {
    return "job_detail";
  }
  if (combined.includes("/jobs") || combined.includes("careers")) {
    return "job_listing";
  }
  if (combined.includes("login") || combined.includes("sign in")) {
    return "login_wall";
  }
  if (combined.includes("modal") || combined.includes("popup")) {
    return "modal";
  }
  if (combined.includes("openai.com") || combined.includes("example.com")) {
    return "homepage";
  }
  return "unknown";
}

function assessGoalRelevance(
  taskInstruction: string,
  snapshot: BrowserStateSnapshot,
): BrowserProgressAssessment["goalRelevance"] {
  const haystack = `${taskInstruction} ${snapshot.url ?? ""} ${snapshot.title ?? ""}`.toLowerCase();
  if (haystack.includes("openai") && (snapshot.url?.toLowerCase().includes("openai") || snapshot.title?.toLowerCase().includes("openai"))) {
    return "high";
  }
  if (snapshot.pageKind === "job_detail" || snapshot.pageKind === "job_listing" || snapshot.pageKind === "search_results") {
    return "medium";
  }
  return "unknown";
}

function interpretBrowserFailure(
  record: ToolExecutionRecord,
  snapshot: BrowserStateSnapshot,
): {
  reason: string;
  summary: string;
  recommendedNext: string;
} {
  const command = record.input || "unknown command";
  const location = snapshot.title ?? snapshot.url ?? "the current page";
  const rawError = typeof record.output === "string" ? record.output.toLowerCase() : "";
  if (/matched \d+ elements/.test(rawError)) {
    return {
      reason: `The browser command \`${command}\` failed because the selector matched multiple elements on ${location}.`,
      summary: `Browser execution is stalled because selector ambiguity prevented \`${command}\` from choosing a single target on ${location}.`,
      recommendedNext: "Capture a fresh snapshot and switch to a more specific selector or element ref before retrying.",
    };
  }
  if (/selector .*not found|locator not found|no nodes matched/.test(rawError)) {
    return {
      reason: `The browser command \`${command}\` failed because the target element could not be found on ${location}.`,
      summary: `Browser execution is stalled because the target for \`${command}\` is not present on ${location}.`,
      recommendedNext: "Refresh the page context with snapshot/get title/get url and choose a selector that exists on the current page.",
    };
  }
  if (/not interactable|intercepted|obscured|detached|timeout|timed out|navigation failed|net::|network/i.test(rawError)) {
    return {
      reason: `The browser command \`${command}\` failed because navigation or page loading did not complete successfully on ${location}.`,
      summary: `Browser execution is stalled because page loading or navigation failed while running \`${command}\`.`,
      recommendedNext: "Verify the URL and page readiness, then retry with a simpler navigation or wait step.",
    };
  }

  return {
    reason: `The browser command \`${command}\` failed before the page state advanced on ${location}.`,
    summary: `Browser execution is stalled because the command \`${command}\` failed on ${location}.`,
    recommendedNext: "Inspect the failed browser command, refresh the page context, and retry with a more precise action.",
  };
}

function getBrowserUrl(record: ToolExecutionRecord | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  return asOptionalString(record.metadata?.url)
    ?? (typeof record.output === "object" ? pickString(record.output, ["url", "currentUrl", "pageUrl"]) : undefined);
}

function getBrowserTitle(record: ToolExecutionRecord | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  return asOptionalString(record.metadata?.title)
    ?? (typeof record.output === "object" ? pickString(record.output, ["title"]) : undefined);
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
