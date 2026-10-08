import { ArrError, type ArrCommand, type SystemStatus } from "./types.js";

export interface ArrClientOptions {
  baseUrl: string;
  apiKey: string;
  /**
   * Request timeout in ms. Default 30s — metadata lookups (TVDB/TMDB) go
   * through the *arr and can be slow, especially behind a VPN.
   */
  timeoutMs?: number;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Base HTTP client for the Sonarr/Radarr v3 API.
 * All requests use the X-Api-Key header against `{baseUrl}/api/v3`.
 */
export class ArrClient {
  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly timeoutMs: number;

  constructor(opts: ArrClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  protected buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(`${this.baseUrl}/api/v3${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  protected async request<T>(
    method: string,
    path: string,
    opts: { query?: QueryParams; body?: unknown } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.buildUrl(path, opts.query), {
        method,
        headers: {
          "X-Api-Key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!res.ok) {
        throw new ArrError(
          `*arr API ${method} ${path} failed with ${res.status}`,
          res.status,
          parsed,
        );
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof ArrError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ArrError(
          `*arr API ${method} ${path} timed out (${this.baseUrl})`,
        );
      }
      // Node fetch wraps network errors ("fetch failed") — surface the cause
      // so connection problems are actionable (ECONNREFUSED, ENOTFOUND, …).
      const cause = (err as { cause?: Error }).cause;
      const detail = cause?.message
        ? `${err instanceof Error ? err.message : String(err)} (${cause.message})`
        : err instanceof Error
          ? err.message
          : String(err);
      throw new ArrError(`*arr API ${method} ${path} failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Connection test. */
  async systemStatus(): Promise<SystemStatus> {
    return this.request<SystemStatus>("GET", "/system/status");
  }

  /** Poll an async command (e.g. ManualImport). */
  async getCommand(id: number): Promise<ArrCommand> {
    return this.request<ArrCommand>("GET", `/command/${id}`);
  }
}
