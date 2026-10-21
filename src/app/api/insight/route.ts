import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MODEL = "gemini-3.8-flash";
const ATTEMPT_MS = 20_000;
const RETRY_PAUSE_MS = 1_500;
const MAX_ATTEMPTS = 2;

type InsightLog = { title?: unknown; reason?: unknown };

function parseModelJson(text: string): unknown {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    const candidate =
      objectMatch && arrayMatch
        ? objectMatch[0].length >= arrayMatch[0].length
          ? objectMatch[0]
          : arrayMatch[0]
        : objectMatch?.[0] || arrayMatch?.[0];
    if (!candidate) throw error;
    return JSON.parse(candidate);
  }
}

function insightPrompt(logs: InsightLog[]): string {
  const lines = logs
    .slice(0, 15)
    .map((log) => {
      const title = String(log.title || "").slice(0, 200);
      const reason = String(log.reason || "").slice(0, 300);
      return `- 기사: ${title}\n  사유: ${reason}`;
    })
    .join("\n");

  return `너는 뉴스 데이터 분석가야. 사용자가 '불필요하다'고 판단하여 삭제한 기사와 그 사유 목록이 아래에 있어.
이 데이터를 분석해서 다음 수집 때부터 필터링 기준으로 삼을 만한 공통된 패턴을 찾아 제외 규칙을 2~3개 제안해줘.
규칙은 기사 제목에 실제로 나올 수 있는 짧은 말로 써줘.

[삭제 데이터]
${lines}

결과는 다음 JSON 형식만 반환해:
{
  "summary": "최근 삭제된 기사들을 분석한 한두 문장",
  "suggestedRules": ["인재양성 기사 제외", "병원 개원 홍보 제외"]
}`;
}

function geminiErrorText(data: unknown): string {
  if (!data || typeof data !== "object" || !("error" in data)) return "";
  const message = (data as { error?: { message?: unknown } }).error?.message;
  return typeof message === "string" ? message.trim() : "";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503 || status === 504;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError"
