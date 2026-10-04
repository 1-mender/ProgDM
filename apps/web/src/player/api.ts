export class PlayerApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class PlayerNetworkError extends Error {
  constructor() {
    super("Нет связи с сервером. Попробуйте ещё раз.");
  }
}

export async function playerRequest<T>(path: string, init: RequestInit = {}, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    const body = await response.json().catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return {};
    }) as { message?: string };
    if (!response.ok) throw new PlayerApiError(body.message ?? "Не удалось выполнить запрос.", response.status);
    return body as T;
  } catch (error) {
    if (error instanceof PlayerApiError) throw error;
    if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) {
      throw new PlayerNetworkError();
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function playerPost<T>(credential: string, path: string, body: object): Promise<T> {
  return playerRequest<T>(path, {
    method: "POST",
    headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });
}

export async function playerGet<T>(credential: string, path: string): Promise<T> {
  return playerRequest<T>(path, {
    headers: { Authorization: "Bearer " + credential },
    cache: "no-store"
  });
}
