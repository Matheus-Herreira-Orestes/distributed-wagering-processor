/** Small dependency-free observability boundary; replaceable by an OpenTelemetry adapter. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  increment(name: string, labels: Record<string, string> = {}): void {
    const key = `${name}{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',')}}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
  set(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = `${name}{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',')}}`;
    this.counters.set(key, value);
  }
  snapshot(): Record<string, number> { return Object.fromEntries(this.counters); }
}
export const metrics = new Metrics();
export function log(event: string, fields: Record<string, unknown> = {}): void {
  // Deliberately receives identifiers and status only: never raw wager payloads or balances.
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}
