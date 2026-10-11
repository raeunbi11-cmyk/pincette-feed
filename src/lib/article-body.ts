import { load } from "cheerio";

import { plainText } from "./collect-criteria";
import { safeFetch } from "./ssrf";

const NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "nav",
  "footer",
  "header",
  "form",
  "aside",
  "[role='navigation']",
  "[role='banner']",
  ".ad",
  ".ads",
  ".advertisement",
  ".related",
  ".reply",
  "#comment",
  ".comment",
].join(", ");

const BODY_SELECTORS = [
  "article",
  "[itemprop='articleBody']",
  "#articleBody",
  "#articeBody",
  ".article-body",
  ".article_body",
  ".news_body",
  ".news-body",
  "#newsBody",
  "#CmAdContent",
  "#dic_area",
  "#newsct_article",
  ".story-news",
  "main",
];

export type ArticleText = {
  title: string;
  text: string;
  description: string;
};

export function extractArticleText(html: string): ArticleText {
  const $ = load(html);
  const title = plainText(
    $("meta[property='og:title']").attr("content") || $("meta[name='twitter:title']").attr("content") || $("title").first().text() || "",
  );
  const description = plainText(
    $("meta[property='og:description']").attr("content") ||
      $("meta[name='description']").attr("content") ||
      $("meta[name='twitter:description']").attr("content") ||
      "",
  );

  $(NOISE_SELECTORS).remove();

  let text = "";
  for (const selector of BODY_SELECTORS) {
    const candidate = plainText($(selector).first().text());
    if (candidate.length > text.length) text = candidate;
    if (text.length > 500) break;
  }
  if (text.length < 80) {
    const body = plainText($("body").text());
    if (body.length > text.length) text = body;
  }

  return {
    title,
    description,
    text: text.slice(0, 6000),
  };
}

export async function readArticle(url: string): Promise<ArticleText | null> {
  try {
    const response = await safeFetch(url, {
      timeoutMs: 8000,
      maxBytes: 1_200_000,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    });
    if (response.status < 200 || response.status >= 300) return null;
    const type = response.contentType.toLowerCase();
    if (type && !type.includes("html") && !type.includes("xml") && !type.includes("text")) return null;
    const extracted = extractArticleText(response.text);
    if (!extracted.text && !extracted.description) return null;
    return extracted;
  } catch {
    return null;
  }
}
