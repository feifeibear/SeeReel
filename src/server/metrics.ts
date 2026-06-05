type Labels = Record<string, string | number | boolean | undefined>;

type CounterMetric = {
  type: "counter";
  help: string;
  values: Map<string, { labels: Record<string, string>; value: number }>;
};

type GaugeMetric = {
  type: "gauge";
  help: string;
  values: Map<string, { labels: Record<string, string>; value: number }>;
};

type HistogramMetric = {
  type: "histogram";
  help: string;
  buckets: number[];
  values: Map<string, { labels: Record<string, string>; buckets: number[]; count: number; sum: number }>;
};

type Metric = CounterMetric | GaugeMetric | HistogramMetric;

const registry = new Map<string, Metric>();

function normalizeLabels(labels: Labels = {}) {
  const normalized: Record<string, string> = {};
  Object.entries(labels).forEach(([key, value]) => {
    if (value !== undefined) normalized[key] = String(value);
  });
  return normalized;
}

function keyFor(labels: Record<string, string>) {
  return Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join(",");
}

function labelText(labels: Record<string, string>) {
  const entries = Object.entries(labels);
  if (!entries.length) return "";
  const body = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`)
    .join(",");
  return `{${body}}`;
}

function metric(name: string, help: string, type: Metric["type"], buckets?: number[]) {
  const existing = registry.get(name);
  if (existing) return existing;
  const created: Metric = type === "histogram"
    ? { type, help, buckets: buckets || [], values: new Map() }
    : { type, help, values: new Map() } as CounterMetric | GaugeMetric;
  registry.set(name, created);
  return created;
}

export function incCounter(name: string, help: string, labels?: Labels, by = 1) {
  const item = metric(name, help, "counter") as CounterMetric;
  const normalized = normalizeLabels(labels);
  const key = keyFor(normalized);
  const prev = item.values.get(key) || { labels: normalized, value: 0 };
  prev.value += by;
  item.values.set(key, prev);
}

export function setGauge(name: string, help: string, labels: Labels | undefined, value: number) {
  if (!Number.isFinite(value)) return;
  const item = metric(name, help, "gauge") as GaugeMetric;
  const normalized = normalizeLabels(labels);
  item.values.set(keyFor(normalized), { labels: normalized, value });
}

export function observeHistogram(name: string, help: string, buckets: number[], labels: Labels | undefined, value: number) {
  if (!Number.isFinite(value)) return;
  const item = metric(name, help, "histogram", buckets) as HistogramMetric;
  const normalized = normalizeLabels(labels);
  const key = keyFor(normalized);
  const prev = item.values.get(key) || { labels: normalized, buckets: Array(item.buckets.length).fill(0), count: 0, sum: 0 };
  item.buckets.forEach((bucket, index) => {
    if (value <= bucket) prev.buckets[index] += 1;
  });
  prev.count += 1;
  prev.sum += value;
  item.values.set(key, prev);
}

export const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
export const STORE_SAVE_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

export function metricsText() {
  const lines: string[] = [];
  for (const [name, item] of registry) {
    lines.push(`# HELP ${name} ${item.help}`);
    lines.push(`# TYPE ${name} ${item.type}`);
    if (item.type === "histogram") {
      for (const entry of item.values.values()) {
        item.buckets.forEach((bucket, index) => {
          lines.push(`${name}_bucket${labelText({ ...entry.labels, le: String(bucket) })} ${entry.buckets[index]}`);
        });
        lines.push(`${name}_bucket${labelText({ ...entry.labels, le: "+Inf" })} ${entry.count}`);
        lines.push(`${name}_sum${labelText(entry.labels)} ${entry.sum}`);
        lines.push(`${name}_count${labelText(entry.labels)} ${entry.count}`);
      }
    } else {
      for (const entry of item.values.values()) {
        lines.push(`${name}${labelText(entry.labels)} ${entry.value}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function observeHttpRequest(labels: { method: string; route: string; status: number }, durationSeconds: number) {
  incCounter("reelyai_http_requests_total", "Total HTTP requests by method, normalized route, and status.", labels);
  observeHistogram("reelyai_http_request_duration_seconds", "HTTP request duration in seconds.", HTTP_DURATION_BUCKETS, labels, durationSeconds);
}

export function setHttpInflight(labels: { method: string; route: string }, value: number) {
  setGauge("reelyai_http_inflight_requests", "In-flight HTTP requests by method and normalized route.", labels, value);
}

export function observeStoreSave(status: "ok" | "error", durationSeconds: number) {
  incCounter("reelyai_store_save_total", "Total JSON store save attempts by status.", { status });
  observeHistogram("reelyai_store_save_duration_seconds", "JSON store save duration in seconds.", STORE_SAVE_BUCKETS, { status }, durationSeconds);
}
