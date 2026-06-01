/**
 * fetchWithRetry — wraps `fetch()` with per-attempt timeout + exponential-backoff retry.
 *
 * The retry policy is **idempotency-aware** because the cinema_agent server makes both
 * idempotent calls (Seedance polling, OpenAI dryRun previews) and side-effect-creating calls
 * (Seedance task submission, image generation). Blindly retrying a creation POST that timed out
 * server-side risks creating a duplicate Seedance task — which costs real money and produces
 * orphan tasks the user didn't ask for.
 *
 * Decision matrix:
 *
 *   error class                            | GET / idempotent=true | POST / idempotent=false
 *   --------------------------------------:|:---------------------:|:----------------------:
 *   network ("fetch failed", ECONN*, DNS)  | retry                 | retry (req didn't reach server)
 *   our-side timeout (per-attempt abort)   | retry                 | NO retry (server may be processing)
 *   caller-aborted signal                  | rethrow               | rethrow
 *   HTTP 5xx                               | retry                 | NO retry (server may have processed)
 *   HTTP 408 / 429                         | retry (Retry-After)   | NO retry
 *   HTTP 4xx (other)                       | NO retry              | NO retry
 *   HTTP 2xx / 3xx                         | return                | return
 *
 * Backoff is exponential (base × 2^attempt) with ±30% jitter and a hard cap. Honors a
 * Retry-After header on 429 / 503 when present (parsed as seconds or HTTP-date).
 *
 * NOTE: the helper does NOT swallow non-2xx responses. It returns the Response object as-is
 * once retries are exhausted or the response is non-retryable. Callers parse the body and
 * decide how to surface the error (matches the existing requestSeedanceJson contract).
 */

export interface FetchWithRetryOptions extends RequestInit {
  /** Per-attempt timeout in ms. Default 45_000. Set 0 to disable. */
  timeoutMs?: number;
  /** Max retry attempts AFTER the first try. Default 3 (= 4 total HTTP attempts). */
  retries?: number;
  /** Base backoff in ms; doubled each attempt with ±30% jitter. Default 600. */
  initialBackoffMs?: number;
  /** Cap for the exponential backoff. Default 8000. */
  maxBackoffMs?: number;
  /**
   * Whether the caller's request is safe to retry on timeout / 5xx (true) or whether retry must
   * be limited to pre-flight network errors only (false). Default true for GET, false otherwise.
   */
  idempotent?: boolean;
  /** Short tag for log lines so multiple concurrent retries are distinguishable. */
  tag?: string;
}

export async function fetchWithRetry(url: string, opts: FetchWithRetryOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const retries = Math.max(0, opts.retries ?? 3);
  const baseBackoff = Math.max(50, opts.initialBackoffMs ?? 600);
  const maxBackoff = Math.max(baseBackoff, opts.maxBackoffMs ?? 8000);
  const method = (opts.method || "GET").toUpperCase();
  // HTTP semantic: GET/HEAD/OPTIONS/DELETE/PUT are idempotent by spec; POST/PATCH are not.
  // Caller can override via opts.idempotent (e.g. for "logically idempotent" POSTs that include
  // a client-generated request id).
  const defaultIdempotent = method === "GET" || method === "HEAD" || method === "OPTIONS"
    || method === "DELETE" || method === "PUT";
  const idempotent = opts.idempotent ?? defaultIdempotent;
  const tag = opts.tag || abbreviateUrl(url);

  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const callerSignal = opts.signal;
    let onCallerAbort: (() => void) | undefined;
    if (callerSignal) {
      if (callerSignal.aborted) {
        ac.abort(callerSignal.reason);
      } else {
        onCallerAbort = () => ac.abort(callerSignal.reason);
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => ac.abort(new TimeoutAbortReason(timeoutMs)), timeoutMs)
      : undefined;

    try {
      const response = await fetch(url, { ...opts, signal: ac.signal });
      if (timer) clearTimeout(timer);
      if (callerSignal && onCallerAbort) callerSignal.removeEventListener("abort", onCallerAbort);

      if (response.ok || response.status < 400) return response;

      const retryable = isRetryableStatus(response.status, idempotent);
      if (!retryable || attempt >= retries) return response;

      const wait = computeBackoff(attempt, baseBackoff, maxBackoff, response);
      console.warn(`[fetchWithRetry] ${tag} attempt ${attempt + 1}/${retries + 1} HTTP ${response.status}; retrying in ${wait}ms`);
      // Drain the body so the connection can be reused; ignore failures.
      try { await response.text(); } catch {}
      lastResponse = response;
      await sleep(wait);
      continue;
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (callerSignal && onCallerAbort) callerSignal.removeEventListener("abort", onCallerAbort);

      // Caller-initiated abort takes precedence over our retry policy.
      if (callerSignal?.aborted) throw err;

      const ourTimeout = ac.signal.aborted && ac.signal.reason instanceof TimeoutAbortReason;
      const transientNetwork = !ourTimeout && isNetworkError(err);
      const retryable = idempotent && (transientNetwork || ourTimeout);
      lastError = ourTimeout
        ? new Error(`fetch timeout after ${timeoutMs}ms (${tag})`)
        : err;

      if (!retryable || attempt >= retries) {
        throw lastError;
      }
      const wait = computeBackoff(attempt, baseBackoff, maxBackoff);
      const why = ourTimeout ? `timeout` : `network (${describeNetworkError(err)})`;
      console.warn(`[fetchWithRetry] ${tag} attempt ${attempt + 1}/${retries + 1} ${why}; retrying in ${wait}ms`);
      await sleep(wait);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError ?? new Error(`fetchWithRetry: exhausted ${retries + 1} attempts for ${tag}`);
}

class TimeoutAbortReason extends Error {
  constructor(timeoutMs: number) {
    super(`fetchWithRetry timeout after ${timeoutMs}ms`);
    this.name = "TimeoutAbortReason";
  }
}

function isRetryableStatus(status: number, idempotent: boolean): boolean {
  if (status === 429) return idempotent;     // avoid replaying non-idempotent create requests
  if (status === 408) return idempotent;     // request timeout server-side; mirrors timeout class
  if (status >= 500 && status < 600) return idempotent;
  return false;
}

/**
 * Detect network-layer failures that imply the request never reached the upstream's app server.
 * Node's undici wraps these in a TypeError with `message === "fetch failed"` and a `cause`
 * containing the underlying syscall-style error.
 */
function isNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    const causeCode = cause && typeof cause === "object" && "code" in (cause as Record<string, unknown>)
      ? String((cause as Record<string, unknown>).code)
      : "";
    const blob = `${err.message}|${causeMsg}|${causeCode}`;
    if (/fetch failed/i.test(err.message)) return true;
    if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|other side closed/i.test(blob)) return true;
  }
  return false;
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) return `${err.message}: ${cause.message}`;
    return err.message;
  }
  return String(err);
}

function computeBackoff(attempt: number, base: number, max: number, response?: Response): number {
  // Honor server-provided Retry-After when present (seconds or HTTP-date format).
  if (response) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const asNumber = Number(retryAfter);
      if (Number.isFinite(asNumber) && asNumber > 0) {
        return Math.min(max * 4, Math.round(asNumber * 1000));  // allow up to 4× cap on explicit hint
      }
      const asDate = Date.parse(retryAfter);
      if (Number.isFinite(asDate)) {
        const delta = asDate - Date.now();
        if (delta > 0) return Math.min(max * 4, delta);
      }
    }
  }
  const exp = base * Math.pow(2, attempt);
  const jitter = (Math.random() * 0.6 - 0.3) * exp; // ±30%
  return Math.min(max, Math.max(50, Math.round(exp + jitter)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abbreviateUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.length > 60 ? url.slice(0, 57) + "..." : url;
  }
}
