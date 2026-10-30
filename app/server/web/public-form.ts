import { err, ok, type Result } from "../result";

/** Small URL-encoded public forms; enforce actual bytes, not a trusted header. */
export async function readPublicForm(
  request: Request,
  limit: number,
): Promise<Result<FormData, { message: string; status: number }>> {
  const invalid = (status = 400) =>
    err({ message: "Invalid public form request. Reload the page and try again.", status });
  if (Number(request.headers.get("content-length")) > limit) return invalid(413);
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  )
    return invalid(415);
  const reader = request.body?.getReader();
  if (!reader) return invalid();
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0,
      text = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return invalid(413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const form = new FormData();
    for (const [key, value] of new URLSearchParams(text)) {
      if (form.has(key)) return invalid();
      form.set(key, value);
    }
    return ok(form);
  } catch {
    return invalid();
  } finally {
    reader.releaseLock();
  }
}
