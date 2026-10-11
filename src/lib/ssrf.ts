import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import iconv from "iconv-lite";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export class UnsafeUrlError extends Error {
  constructor(message = "허용되지 않은 주소입니다.") {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export function isPrivateIp(ip: string): boolean {
  let value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);

  if (value.includes(":")) {
    if (value === "::1" || value === "::") return true;
    const first = value.split(":")[0] || "0";
    const head = Number.parseInt(first || "0", 16);
    if (Number.isNaN(head)) return true;
    if (head >= 0xfc00 && head <= 0xfdff) return true;
    if (head >= 0xfe80 && head <= 0xfebf) return true;
    return false;
  }

  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "metadata.google.internal" || host === "metadata.google") return true;
  return false;
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("기사 주소 형식이 올바르지 않습니다.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("http와 https 주소만 열 수 있습니다.");
  }
  if (url.username || url.password) throw new UnsafeUrlError("인증 정보가 포함된 주소는 열 수 없습니다.");
  if (isBlockedHostname(url.hostname)) throw new UnsafeUrlError("내부 주소는 열 수 없습니다.");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some((address) => isPrivateIp(address))) {
    throw new UnsafeUrlError("공개된 뉴스 주소만 열 수 있습니다.");
  }

  return url;
}

export type SafeFetchOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
};

export type SafeResponse = {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  text: string;
};

function decodeBody(body: Buffer, contentType: string): string {
  const headerCharset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  const sniff = body.subarray(0, 4096).toString("latin1");
  const metaCharset = /charset\s*=\s*["']?\s*([^"'>\s/]+)/i.exec(sniff)?.[1];
  const charset = (headerCharset || metaCharset || "utf-8").toLowerCase();
  const normalized = charset === "utf8" ? "utf-8" : charset;
  if (normalized === "utf-8" || normalized === "us-ascii" || !iconv.encodingExists(normalized)) {
    return body.toString("utf8");
  }
  return iconv.decode(body, normalized);
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = Buffer.from(value);
    const room = maxBytes - total;
    chunks.push(next.byteLength > room ? next.subarray(0, room) : next);
    total += Math.min(next.byteLength, room);
    if (next.byteLength > room) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks);
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  let current = await assertPublicHttpUrl(rawUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 1_500_000;

  for (let hop = 0; hop <= 5; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(current.toString(), {
        method: hop === 0 ? options.method ?? "GET" : "GET",
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
          ...(hop === 0 ? options.headers : {}),
        },
        body: hop === 0 ? options.body : undefined,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("리다이렉트 주소가 없습니다.");
        current = await assertPublicHttpUrl(new URL(location, current).toString());
        continue;
      }

      const body = await readLimited(response, maxBytes);
      const contentType = response.headers.get("content-type") ?? "";
      return {
        finalUrl: current.toString(),
        status: response.status,
        contentType,
        body,
        text: decodeBody(body, contentType),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("리다이렉트가 너무 많습니다.");
}
