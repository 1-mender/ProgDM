async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message ?? "Не удалось выполнить запрос.");
  return body as T;
}

export async function playerPost<T>(credential: string, path: string, body: object): Promise<T> {
  return readResponse<T>(await fetch(path, {
    method: "POST",
    headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  }));
}
