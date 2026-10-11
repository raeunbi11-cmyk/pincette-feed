import assert from "node:assert/strict";
import test from "node:test";

import { extractArticleText } from "../src/lib/article-body";
import {
  canonicalUrlKey,
  dedupeArticles,
  excludedByRules,
  isBlockedPublisher,
  parseCollectInput,
  scoreArticle,
  withinFetchRange,
} from "../src/lib/collect-criteria";
import { extractBingTarget, googleArticleId, parseGoogleBatchUrl, parseRssItems } from "../src/lib/collect-news";
import { isPrivateIp } from "../src/lib/ssrf";

test("blocks private and metadata addresses", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.1.2.3"), true);
  assert.equal(isPrivateIp("192.168.0.12"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("1.1.1.1"), false);
});

test("blocks blogs and communities while keeping news hosts", () => {
  assert.equal(isBlockedPublisher("https://someblog.tistory.com/12"), true);
  assert.equal(isBlockedPublisher("https://blog.naver.com/writer/1"), true);
  assert.equal(isBlockedPublisher("https://www.biotimes.co.kr/news/articleView.html?idxno=1"), false);
  assert.equal(isBlockedPublisher("https://news.google.com/rss/articles/abc"), false);
});

test("parses Google News RSS items and drops the source suffix from the title", () => {
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title>디지털 헬스케어 수출 전략 - 바이오타임즈</title>
    <link>https://news.google.com/rss/articles/CBMiTest?oc=5</link>
    <pubDate>Thu, 08 Oct 2026 00:15:25 GMT</pubDate>
    <description>&lt;a href="https://news.google.com/rss/articles/CBMiTest"&gt;디지털 헬스케어 수출 전략&lt;/a&gt;</description>
    <source url="https://www.biotimes.co.kr">바이오타임즈</source>
  </item></channel></rss>`;
  const items = parseRssItems(xml, "google");
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "디지털 헬스케어 수출 전략");
  assert.equal(items[0].source, "바이오타임즈");
  assert.equal(googleArticleId(items[0].url), "CBMiTest");
});

test("reads the publisher URL out of a Bing click redirect", () => {
  const link =
    "https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fwww.example.com%2Fnews%2F1&c=1";
  assert.equal(extractBingTarget(link), "https://www.example.com/news/1");
});

test("parses a Google batch-execute publisher URL", () => {
  const payload = `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.biotimes.co.kr/news/articleView.html?idxno=35045\\"]",null,null,null,"generic"]]`;
  assert.equal(
    parseGoogleBatchUrl(payload),
    "https://www.biotimes.co.kr/news/articleView.html?idxno=35045",
  );
});

test("dedupes the same story from Google and Bing", () => {
  const items = dedupeArticles([
    { title: "시니어타운 분양 소식", url: "https://news.google.com/rss/articles/AAA" },
    { title: "시니어타운 분양 소식 - 매일경제", url: "https://www.mk.co.kr/news/1?utm_source=rss" },
    { title: "시니어타운 분양 소식", url: "https://www.mk.co.kr/news/1" },
  ]);
  assert.equal(items.length, 2);
  assert.equal(canonicalUrlKey("https://www.mk.co.kr/news/1?utm_source=rss"), "mk.co.kr/news/1");
});

test("applies exclude rules and the fetch window", () => {
  assert.equal(excludedByRules("오늘 주식 종목 추천", "급등주 정리", ["단순 주식 종목 추천"]), true);
  assert.equal(excludedByRules("병원 디지털 전환 MOU", "스타트업과 협약", ["단순 주식 종목 추천"]), false);
  const now = new Date("2026-10-11T12:00:00Z");
  assert.equal(withinFetchRange(new Date("2026-10-09T12:00:00Z"), 7, now), true);
  assert.equal(withinFetchRange(new Date("2026-09-01T12:00:00Z"), 7, now), false);
});

test("scores a keyword hit in the title above a loose mention", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const high = scoreArticle({
    title: "디지털 헬스케어 기업, 병원 MOU",
    text: "경쟁사 서비스 출시와 협약 소식",
    keyword: "디지털 헬스케어",
    purpose: "경쟁사 동향 파악",
    focus: "MOU 체결 현황",
    publishedAt: new Date("2026-10-11T01:00:00Z"),
    now,
  });
  const low = scoreArticle({
    title: "날씨 소식",
    text: "주말 맑음",
    keyword: "디지털 헬스케어",
    purpose: "경쟁사 동향",
    focus: "MOU",
    publishedAt: new Date("2026-10-01T01:00:00Z"),
    now,
  });
  assert.ok(high > low);
  assert.ok(high >= 70);
});

test("extracts the article body and ignores navigation", () => {
  const html = `<html><head><title>제목 - 매체</title><meta property="og:description" content="한 줄 설명"></head>
    <body><nav>메뉴 홈 로그인</nav><article><p>디지털 헬스케어 기업이 병원과 MOU를 체결했다. 해외 판로도 연다.</p></article></body></html>`;
  const extracted = extractArticleText(html);
  assert.match(extracted.text, /MOU를 체결했다/);
  assert.equal(extracted.description, "한 줄 설명");
  assert.doesNotMatch(extracted.text, /로그인/);
});

test("rejects a collect request without keywords", () => {
  assert.throws(() => parseCollectInput({ keywords: [], role: "기획", purpose: "조사", focus: "동향" }), /키워드/);
  const parsed = parseCollectInput({
    keywords: [" 디지털 헬스케어 ", "디지털 헬스케어"],
    fetchRange: "7",
    role: "기획자",
    purpose: "동향 파악",
    focus: "MOU",
    excludeRules: ["홍보"],
  });
  assert.deepEqual(parsed.keywords, ["디지털 헬스케어"]);
  assert.equal(parsed.fetchRangeDays, 7);
});
