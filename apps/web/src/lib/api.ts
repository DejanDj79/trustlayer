const DEFAULT_API_BASE = "http://127.0.0.1:8787";

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.trim() || DEFAULT_API_BASE;

export class ApiRequestError extends Error {
  statusCode: number | null;

  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.statusCode = Number.isFinite(Number(statusCode)) ? Number(statusCode) : null;
  }
}

export async function requestJson<T>(pathname: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${pathname}`, {
      signal: controller.signal
    });

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail =
        data && typeof data === "object" && "error" in data
          ? ` ${(data as { error?: string }).error || ""}`.trim()
          : "";
      throw new ApiRequestError(
        `Request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status
      );
    }

    if (!data || typeof data !== "object") {
      throw new ApiRequestError("API returned an invalid response.", response.status);
    }

    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function shouldRetryRequest(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  if (error instanceof ApiRequestError) {
    const code = Number(error.statusCode || 0);
    return [408, 425, 429, 500, 502, 503, 504].includes(code);
  }
  if (error instanceof TypeError) {
    return true;
  }
  return false;
}

interface RequestRetryOptions {
  timeoutMs: number;
  retries?: number;
  retryDelayMs?: number;
}

export async function requestJsonWithRetry<T>(
  pathname: string,
  options: RequestRetryOptions
): Promise<T> {
  const retries = Math.max(0, Number(options.retries || 0));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || 250));
  let attempt = 0;

  while (true) {
    try {
      return await requestJson<T>(pathname, options.timeoutMs);
    } catch (error) {
      if (attempt >= retries || !shouldRetryRequest(error)) {
        throw error;
      }
      const delay = retryDelayMs * Math.pow(2, attempt);
      attempt += 1;
      await wait(delay);
    }
  }
}
