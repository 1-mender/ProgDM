export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class DownloadNetworkError extends Error {
  constructor() { super("Нет связи с сервером. Попробуйте скачать файл ещё раз."); }
}

export async function downloadFile(token: string, path: string, filename: string, timeoutMs = 30000) {
  const controller = new AbortController();
  const message = "Нет связи с сервером. Попробуйте скачать файл ещё раз.";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => { controller.abort(); reject(new Error(message)); }, timeoutMs);
  });
  try {
    const blob = await Promise.race([deadline, (async () => {
      const response = await fetch(path, { headers: { Authorization: "Bearer " + token }, cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new ApiError(result.message ?? "Не удалось скачать файл.", response.status);
      }
      return response.blob();
    })()]);
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url; link.download = filename; link.click();
    } finally { globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new DownloadNetworkError();
  } finally { globalThis.clearTimeout(timer); }
}
