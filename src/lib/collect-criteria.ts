export class CollectInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectInputError";
  }
}

export type CollectInput = {
  keywords: string[];
  fetchRangeDays: number;
  role: string;
  purpose: string;
  focus: string;
  excludeRules: string[];
};

export type CollectedArticle = {
  id: string;
  source: string;
  date: string;
  title: string;
  summary: string;
  score: number;
  url: string;
};

const BLOCKED_HOST_SUFFIXES = [
  "tistory.com",
  "blog.naver.com",
  "cafe.naver.com",
  "post.naver.com",
  "blog.daum.net",
  "cafe.daum.net",
  "brunch.co.kr",
  "medium.com",
  "dcinside.com",
  "clien.net",
  "fmkorea.com",
  "ppomppu.co.kr",
  "ruliweb.com",
  "theqoo.net",
  "instiz.net",
  "mlbpark.donga.com",
  "reddit.com",
  "youtube.com",
  "youtu.be",
  "namu.wiki",
  "wikipedia.org",
];

const STOPWORDS = new Set([
  "단순",
  "특정",
  "기사",
  "관련",
  "최근",
  "대한",
  "위한",
  "또는",
  "그리고",
  "에서",
  "하는",
  "있는",
  "뉴스",
  "내용",
  "정보",
  "현황",
  "이번",
  "오늘",
  "기자",
]);

export function compactText(value: string): string {
  return value.toLowerCase().replace(/[\s·ㆍ.,'"“”‘’!?~()[\]{}<>:;/\\|`_+*=#&%-]+/g, "");
}

export function meaningfulTokens(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .split(/[\s,./|()[\]{}<>:;"'“”‘’!?~·ㆍ]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

export function isBlockedPublisher(rawUrl: string): boolean {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return true;
  }
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function isGoogleNewsUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname === "news.google.com";
  } catch {
    return false;
  }
}

export function isBingRedirect(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.endsWith("bing.com") && url.pathname.includes("apiclick");
  } catch {
    return false;
  }
}

export function canonicalUrlKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "news.google.com") {
      const id = url.pathname.split("/").filter(Boolean).pop() ?? rawUrl;
      return `gnews:${id}`;
    }
    const removable = ["oc", "fbclid", "gclid", "ref", "rss"];
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || removable.includes(lower)) url.searchParams.delete(key);
    }
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const query = url.searchParams.toString();
    return `${host}${path}${query ? `?${query}` : ""}`;
  } catch {
    return compactText(rawUrl).slice(0, 180);
  }
}

export function titleKey(title: string): string {
  return compactText(title).slice(0, 48);
}

export function dedupeArticles<T extends { title: string; url: string }>(items: T[]): T[] {
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const title = titleKey(item.title);
    const url = canonicalUrlKey(item.url);
    if ((title && seenTitles.has(title)) || (url && seenUrls.has(url))) continue;
    if (title) seenTitles.add(title);
    if (url) seenUrls.add(url);
    unique.push(item);
  }
  return unique;
}

export function withinFetchRange(publishedAt: Date | null, days: number, now = new Date()): boolean {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return false;
  const age = now.getTime() - publishedAt.getTime();
  const graceMs = 6 * 60 * 60 * 1000;
  if (age < -graceMs) return false;
  return age <= days * 24 * 60 * 60 * 1000 + graceMs;
}

export function formatKoreanDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts.replaceAll("-", ".");
}

export function excludedByRules(title: string, text: string, rules: string[]): boolean {
  const raw = `${title}\n${text}`.toLowerCase();
  const compact = compactText(raw);
  for (const rule of rules) {
    const normalizedRule = compactText(rule);
    if (normalizedRule.length >= 4 && compact.includes(normalizedRule)) return true;
    const tokens = meaningfulTokens(rule);
    if (tokens.length < 2) continue;
    const hits = tokens.filter((token) => raw.includes(token) || compact.includes(compactText(token)));
    if (hits.length >= 2 && hits.length / tokens.length >= 0.5) return true;
  }
  return false;
}

export function scoreArticle(args: {
  title: string;
  text: string;
  keyword: string;
  purpose: string;
  focus: string;
  publishedAt: Date | null;
  now?: Date;
}): number {
  const title = args.title.toLowerCase();
  const text = args.text.toLowerCase();
  const compactTitle = compactText(args.title);
  const compactBody = compactText(`${args.title} ${args.text}`);
  const keyword = args.keyword.trim().toLowerCase();
  const compactKeyword = compactText(keyword);

  let score = 48;
  if (compactKeyword && compactTitle.includes(compactKeyword)) score += 24;
  else if (keyword && keyword.split(/\s+/).filter((part) => part.length >= 2).every((part) => title.includes(part))) {
    score += 20;
  } else if (compactKeyword && compactBody.includes(compactKeyword)) score += 12;

  const focusTokens = meaningfulTokens(`${args.focus} ${args.purpose}`).slice(0, 16);
  let focusHits = 0;
  for (const token of focusTokens) {
    if (title.includes(token) || compactTitle.includes(compactText(token))) focusHits += 2;
    else if (text.includes(token) || compactBody.includes(compactText(token))) focusHits += 1;
  }
  score += Math.min(22, focusHits * 3);

  if (args.publishedAt && !Number.isNaN(args.publishedAt.getTime())) {
    const ageDays = ((args.now ?? new Date()).getTime() - args.publishedAt.getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays <= 1) score += 8;
    else if (ageDays <= 3) score += 4;
  }

  return Math.max(1, Math.min(99, Math.round(score)));
}

export function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

export function firstSentence(value: string, max = 150): string {
  const clean = plainText(value);
  if (!clean) return "";
  const match = clean.match(/^.{24,150}?[.!?。]/);
  const sentence = (match ? match[0] : clean.slice(0, max)).trim();
  return sentence.length > max ? `${sentence.slice(0, max - 1).trim()}…` : sentence;
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new CollectInputError(`${label}을 입력해야 기사를 선별할 수 있습니다.`);
  return text.slice(0, 500);
}

export function parseCollectInput(body: unknown): CollectInput {
  if (!body || typeof body !== "object") throw new CollectInputError("수집 조건이 없습니다.");
  const raw = body as Record<string, unknown>;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
    : [];
  if (keywords.length === 0) throw new CollectInputError("검색 키워드를 1개 이상 등록해주세요.");
  if (keywords.length > 12) throw new CollectInputError("키워드는 한 번에 12개까지 수집할 수 있습니다.");
  if (keywords.some((keyword) => keyword.length > 80)) {
    throw new CollectInputError("키워드는 80자 이하로 입력해주세요.");
  }

  const requestedRange = Number(raw.fetchRange ?? raw.fetchRangeDays ?? 7);
  const fetchRangeDays = Number.isFinite(requestedRange) ? Math.min(30, Math.max(1, Math.round(requestedRange))) : 7;

  return {
    keywords: [...new Set(keywords)].slice(0, 12),
    fetchRangeDays,
    role: requiredText(raw.role, "직무"),
    purpose: requiredText(raw.purpose, "활용 목적"),
    focus: requiredText(raw.focus, "상세 기준"),
    excludeRules: Array.isArray(raw.excludeRules)
      ? raw.excludeRules.map((rule) => String(rule).trim()).filter(Boolean).slice(0, 40)
      : [],
  };
}
