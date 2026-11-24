// A small Discord REST client for an application's own bot token.

export const API = "https://discord.com/api/v10";
const VERSION = "0.1.0";

/** A Discord API error, with Discord's own code and message when it sent them. */
export class DiscordApiError extends Error {
  name = "DiscordApiError";
  readonly status: number;
  readonly code: number | null;
  /** Field-level errors from a 400, flattened to "path: message". */
  readonly details: string[];

  constructor(status: number, code: number | null, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiOptions {
  token: string;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each request, e.g. for --verbose. Never sees the token. */
  onRequest?: (method: string, path: string) => void;
}

export interface Api {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

const MAX_RATE_LIMIT_WAIT_MS = 60_000;

export function createApi(options: ApiOptions): Api {
  const fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        options.onRequest?.(method, path);
        const res = await fetchFn(API + path, {
          method,
          headers: {
            Authorization: `Bot ${options.token}`,
            // Discord asks bots to identify themselves this way.
            "User-Agent": `DiscordBot (https://github.com/tyler-void/stagedoor, ${VERSION})`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        let data: unknown = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        if (res.status === 429 && attempt < 2) {
          const seconds = Number((data as { retry_after?: unknown } | null)?.retry_after ?? res.headers.get("retry-after") ?? 1);
          const ms = Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000);
          if (ms <= MAX_RATE_LIMIT_WAIT_MS) {
            await sleep(ms);
            continue;
          }
        }
        if (!res.ok) throw toError(res.status, data, method, path);
        return data as T;
      }
    },
  };
}

function toError(status: number, data: unknown, method: string, path: string): DiscordApiError {
  const d = (data ?? {}) as { code?: unknown; message?: unknown; errors?: unknown };
  const code = typeof d.code === "number" ? d.code : null;
  const message = typeof d.message === "string" ? d.message : `HTTP ${status}`;
  const hint =
    status === 401
      ? " (the bot token is wrong or was reset)"
      : status === 403
        ? " (the bot isn't allowed to do this)"
        : status === 404
          ? " (not found: check the ID or name)"
          : "";
  return new DiscordApiError(status, code, `${method} ${path} failed: ${message}${code !== null ? ` [${code}]` : ""}${hint}`, flattenErrors(d.errors));
}

/** Discord's nested `errors` object -> ["tags.0: Must be 20 or fewer in length."]. */
export function flattenErrors(errors: unknown, prefix = ""): string[] {
  if (typeof errors !== "object" || errors === null) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
    if (key === "_errors" && Array.isArray(value)) {
      for (const e of value) out.push(`${prefix || "(body)"}: ${(e as { message?: string }).message ?? JSON.stringify(e)}`);
    } else {
      out.push(...flattenErrors(value, prefix ? `${prefix}.${key}` : key));
    }
  }
  return out;
}
