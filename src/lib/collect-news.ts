import { createHash } from "node:crypto";

import { readArticle } from "./article-body";
import {
  type CollectInput,
  type CollectedArticle,
  compactText,
  dedupeArticles,
  displaySource,
  excludedByRules,
  leadSentence,
  formatKoreanDate,
  isBingRedirect,
  isBlockedPublisher,
  isGoogleNewsUrl,
  plainText,
  scoreArticle,
  withinFetchRange,
} from "./collect-criteria";
import { safeFetch } from "./ssrf";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const GOOGLE_CONSENT = "SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg";
const PER_FEED = 25;
const SHORTLIST_PER_KEYWORD = 8;
const SHORTLIST_TOTAL = 30;
const FINAL_PER_KEYWORD = 10;
const FINAL_TOTAL = 50;
const DEADLINE_MS = 42_000;

type FeedOrigin = "google" | "bing";

export type RssItem = {
  title: string;
  source: string;
  url: string;
  publishedAt: Date | null;
  description: string;
};

type Candidate = RssItem & {
  keyword: string;
  origin: FeedOrigin;
  bodyText: string;
  score: number;
};

const GOOGLE_SHELL = [
  ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
  "X",
  "X",
  1,
  [1, 1, 1],
  1,
  1,
  null,
  0,
  0,
  null,
  0,
];

function decodeXml(value: string): string {
  let text = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  for (let pass = 0; pass < 2; pass += 1) {
    text = text
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  return text.trim();
}

function tagValue(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function tagAttribute(block: string, name: string, attribute: string): string {
  const match = block.match(new RegExp(`<${name}\\b[^>]*\\b${attribute}="([^"]*)"`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function splitHeadline(rawTitle: string, sourceHint: string): { title: string; source: string } {
  const source = sourceHint.replace(/\s+on\s+MSN$/i, "").trim();
  const match = rawTitle.match(/^(.*)\s[-–—|]\s([^–—|-]{2,40})$/);
  if (!match) return { title: plainText(rawTitle), source: source || "뉴스" };
  return {
    title: plainText(match[1]),
    source: source || plainText(match[2]) || "뉴스",
  };
}

export function parseRssItems(xml: string, origin: FeedOrigin): RssItem[] {
  const items: RssItem[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const headline = splitHeadline(tagValue(block, "title"), origin === "google" ? tagValue(block, "source") : tagValue(block, "News:Source"));
    const link = tagValue(block, "link") || tagValue(block, "guid");
    const pubDate = tagValue(block, "pubDate");
    const publishedAt = pubDate ? new Date(pubDate) : null;
    if (!headline.title || !link) continue;
    items.push({
      title: headline.title,
      source: headline.source,
      url: link,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
      description: plainText(tagValue(block, "description")),
    });
    if (items.length >= PER_FEED) break;
  }
  return items;
}

export function extractBingTarget(link: string): string | null {
  try {
    const url = new URL(link);
    if (!url.hostname.endsWith("bing.com")) return null;
    const target = url.searchParams.get("url");
    if (!target || !/^https?:\/\//i.test(target)) return null;
    return target;
  } catch {
    return null;
  }
}

export function googleArticleId(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.hostname !== "news.google.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.lastIndexOf("articles");
    if (marker < 0 || !parts[marker + 1]) return null;
    return parts[marker + 1];
  } catch {
    return null;
  }
}

export function parseGoogleBatchUrl(payload: string): string | null {
  const jsonPart = payload.includes("\n\n") ? payload.split("\n\n").slice(1).join("\n\n") : payload;
  const trimmed = jsonPart.replace(/^\)\]\}'\s*/, "");
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [];
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[2] !== "string") continue;
      const inner = JSON.parse(row[2]) as unknown;
      if (Array.isArray(inner) && inner[0] === "garturlres" && typeof inner[1] === "string" && /^https?:\/\//i.test(inner[1])) {
        return inner[1];
      }
    }
  } catch {
    const match = payload.match(/garturlres\\?",\\?"(https?:[^"\\]+)/);
    if (!match) return null;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
    }
  }
  return null;
}

async function resolvePublisherUrl(link: string, expired: () => boolean): Promise<string> {
  const bingTarget = extractBingTarget(link);
  if (bingTarget) return bingTarget;
  const articleId = googleArticleId(link);
  if (!articleId || expired()) return link;

  try {
    const page = await safeFetch(`https://news.google.com/rss/articles/${articleId}`, {
      timeoutMs: 10_000,
      headers: { Cookie: GOOGLE_CONSENT, "User-Agent": USER_AGENT },
      accept: "text/html",
    });
    const signature = page.text.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const timestamp = page.text.match(/data-n-a-ts="(\d+)"/)?.[1];
    if (!signature || !timestamp || expired()) return link;

    const inner = JSON.stringify(["garturlreq", GOOGLE_SHELL, articleId, Number(timestamp), signature]);
    const body = new URLSearchParams({
      "f.req": JSON.stringify([[["Fbv4je", inner, null, "generic"]]]),
    }).toString();
    const decoded = await safeFetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      timeoutMs: 10_000,
      headers: {
        Cookie: GOOGLE_CONSENT,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": USER_AGENT,
      },
      body,
      accept: "*/*",
    });
    return parseGoogleBatchUrl(decoded.text) ?? link;
  } catch {
    return link;
  }
}

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function fetchFeed(url: string, origin: FeedOrigin, headers?: Record<string, string>): Promise<RssItem[]> {
  const response = await safeFetch(url, {
    timeoutMs: 12_000,
    maxBytes: 2_000_000,
    accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    headers,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${origin} RSS 응답 오류 (${response.status})`);
  }
  return parseRssItems(response.text, origin);
}

function feedUrls(keyword: string, days: number): Array<{ origin: FeedOrigin; url: string; headers?: Record<string, string> }> {
  const googleQuery = `${encodeURIComponent(keyword)}+when:${days}d`;
  return [
    {
      origin: "google",
      url: `https://news.google.com/rss/search?q=${googleQuery}&hl=ko&gl=KR&ceid=KR:ko`,
      headers: { Cookie: GOOGLE_CONSENT },
    },
    {
      origin: "bing",
      url: `https://www.bing.com/news/search?q=${encodeURIComponent(keyword)}&format=rss&setlang=ko-KR&cc=KR`,
    },
  ];
}

function articleId(url: string, title: string): string {
  return `article_${createHash("sha1").update(`${url}|${title}`).digest("hex").slice(0, 12)}`;
}

function usablePublisher(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (isGoogleNewsUrl(url) || isBingRedirect(url)) return true;
  return !isBlockedPublisher(url);
}

function selectDiverse(items: Candidate[], perKeyword: number, maxTotal: number): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const item of items) {
    const group = groups.get(item.keyword) ?? [];
    group.push(item);
    groups.set(item.keyword, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => b.score - a.score || (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  }

  const picked: Candidate[] = [];
  const keywords = [...groups.keys()];
  for (let round = 0; round < perKeyword && picked.length < maxTotal; round += 1) {
    let added = false;
    for (const keyword of keywords) {
      const item = groups.get(keyword)?.[round];
      if (!item) continue;
      picked.push(item);
      added = true;
      if (picked.length >= maxTotal) break;
    }
    if (!added) break;
  }
  return picked;
}

function toArticle(item: Candidate): CollectedArticle {
  const sentence = leadSentence(item.bodyText) || leadSentence(item.description) || item.title;
  return {
    id: articleId(item.url, item.title),
    source: displaySource(item.source, item.url),
    date: item.publishedAt ? formatKoreanDate(item.publishedAt) : formatKoreanDate(new Date()),
    title: item.title,
    summary: `${sentence} ${item.score}점`,
    score: item.score,
    url: item.url,
  };
}

export async function collectNews(input: CollectInput): Promise<{
  articles: CollectedArticle[];
  totalFetched: number;
  passed: number;
}> {
  const started = Date.now();
  const expired = () => Date.now() - started > DEADLINE_MS;
  const now = new Date();
  const collected: Candidate[] = [];
  const failures: string[] = [];

  await mapPool(input.keywords, 3, async (keyword) => {
    const feeds = await mapPool(feedUrls(keyword, input.fetchRangeDays), 2, async (feed) => {
      try {
        const items = await fetchFeed(feed.url, feed.origin, feed.headers);
        if (items.length === 0 && feed.origin === "google") {
          const fallback = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko`;
          return fetchFeed(fallback, "google", feed.headers);
        }
        return items;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        return [];
      }
    });

    for (const items of feeds) {
      for (const item of items) {
        collected.push({ ...item, keyword, origin: item.url.includes("news.google.com") ? "google" : "bing", bodyText: "", score: 0 });
      }
    }
  });

  if (collected.length === 0) {
    throw new Error(
      failures[0]
        ? `뉴스 RSS를 가져오지 못했습니다. ${failures[0]}`
        : "Google News와 Bing News에서 기사를 찾지 못했습니다. 키워드를 바꿔 다시 시도해주세요.",
    );
  }

  const prelim = collected.filter((item) => {
    if (!item.publishedAt) item.publishedAt = now;
    if (!withinFetchRange(item.publishedAt, input.fetchRangeDays, now)) return false;
    const direct = extractBingTarget(item.url) ?? item.url;
    if (!isGoogleNewsUrl(direct) && !isBingRedirect(direct) && isBlockedPublisher(direct)) return false;
    if (excludedByRules(item.title, item.description, input.excludeRules)) return false;
    item.score = scoreArticle({
      title: item.title,
      text: item.description,
      keyword: item.keyword,
      purpose: input.purpose,
      focus: input.focus,
      publishedAt: item.publishedAt,
      now,
    });
    return true;
  });

  const ordered = [...prelim].sort((a, b) => (a.origin === b.origin ? 0 : a.origin === "google" ? -1 : 1));
  const unique = dedupeArticles(ordered);
  const shortlist = selectDiverse(unique, SHORTLIST_PER_KEYWORD, SHORTLIST_TOTAL);

  const resolved = await mapPool(shortlist, 4, async (item) => {
    const url = await resolvePublisherUrl(item.url, expired);
    return { ...item, url };
  });

  const publishers = dedupeArticles(
    resolved.filter((item) => usablePublisher(item.url) && !isBlockedPublisher(item.url) && !isBingRedirect(item.url)),
  );

  const withBodies = await mapPool(publishers, 4, async (item) => {
    if (expired() || isGoogleNewsUrl(item.url)) return item;
    const article = await readArticle(item.url);
    if (!article) return item;
    const bodyText = article.text || article.description;
    return {
      ...item,
      bodyText,
      source: item.source || article.title.split(" - ").pop() || item.source,
    };
  });

  const reviewed = withBodies.filter((item) => {
    const evidence = `${item.description} ${item.bodyText}`;
    if (excludedByRules(item.title, evidence, input.excludeRules)) return false;
    if (item.bodyText && !compactText(`${item.title} ${item.bodyText} ${item.description}`).includes(compactText(item.keyword).slice(0, 6))) {
      const keywordParts = item.keyword.split(/\s+/).filter((part) => part.length >= 2);
      const haystack = `${item.title} ${item.bodyText} ${item.description}`.toLowerCase();
      if (keywordParts.length > 0 && !keywordParts.some((part) => haystack.includes(part.toLowerCase()))) return false;
    }
    item.score = scoreArticle({
      title: item.title,
      text: evidence,
      keyword: item.keyword,
      purpose: input.purpose,
      focus: input.focus,
      publishedAt: item.publishedAt,
      now,
    });
    return item.score >= 40;
  });

  const articles = selectDiverse(reviewed, FINAL_PER_KEYWORD, FINAL_TOTAL)
    .sort((a, b) => b.score - a.score)
    .map(toArticle);

  return {
    articles,
    totalFetched: unique.length,
    passed: articles.length,
  };
}
