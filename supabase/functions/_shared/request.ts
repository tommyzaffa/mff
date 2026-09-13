// Bound work before parsing JSON/multipart. Content-Length alone is untrusted.
export class RequestError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

export async function boundedRequest(req: Request, maxBytes: number): Promise<Request> {
  if (!req.body) return req;
  const length = Number(req.headers.get("content-length"));
  if (length > maxBytes) throw new RequestError("payload_too_large", 413);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestError("request_timeout", 408));
      void reader.cancel().catch(() => {});
    }, 15_000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RequestError("payload_too_large", 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new Request(req, { body: bytes });
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export function passwordMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function paymentMatches(session: Record<string, unknown>, order: {
  stripe_session_id: string | null; amount_cents: number;
}): boolean {
  return !!order.stripe_session_id && session.id === order.stripe_session_id &&
    session.payment_status === "paid" && session.currency === "chf" &&
    Number.isSafeInteger(session.amount_total) && session.amount_total === order.amount_cents;
}
