const DEFAULT_API_BASE = "http://127.0.0.1:8787";

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.trim() || DEFAULT_API_BASE;

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
      throw new Error(`Request failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }

    if (!data || typeof data !== "object") {
      throw new Error("API returned an invalid response.");
    }

    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}
