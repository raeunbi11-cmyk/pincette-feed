import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 올바른 JSON이 아닙니다." }, { status: 400 });
  }

  const raw = body && typeof body === "object" ? (body as { apiKey?: unknown; logs?: unknown }) : {};
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "Gemini API 키가 없습니다." }, { status: 400 });
  }

  const logs = Array.isArray(raw.logs) ? (raw.logs as InsightLog[]).slice(0, 15) : [];
  if (logs.length === 0) {
    return NextResponse.json({ error: "분석할 삭제 기록이 없습니다." }, { status: 400 });
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: insightPrompt(logs) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      },
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "error" in data
          ? String((data as { error?: { message?: unknown } }).error?.message || "")
          : "";
      return NextResponse.json(
        { error: message || `Gemini 오류 (상태 코드: ${response.status})` },
        { status: 502 },
      );
    }

    const parts = (
      data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }
    ).candidates?.[0]?.content?.parts || [];
    let text = parts
      .filter((part) => part?.text && !part.thought)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) {
      text = parts
        .map((part) => part?.text)
        .filter(Boolean)
        .join("\n")
        .trim();
    }
    if (!text) {
      return NextResponse.json({ error: "AI가 응답을 반환하지 않았습니다." }, { status: 502 });
    }

    const parsed = parseModelJson(text);
    const suggestedRules = Array.isArray(parsed)
      ? parsed.filter((rule): rule is string => typeof rule === "string" && rule.trim().length > 0)
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { suggestedRules?: unknown }).suggestedRules)
        ? (parsed as { suggestedRules: unknown[] }).suggestedRules.filter(
            (rule): rule is string => typeof rule === "string" && rule.trim().length > 0,
          )
        : [];
    const summary =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { summary?: unknown }).summary === "string"
        ? (parsed as { summary: string }).summary
        : "삭제한 기사에서 반복되는 제외 기준을 골랐습니다.";

    if (suggestedRules.length === 0) {
      return NextResponse.json({ error: "AI 응답에 제외 규칙이 없습니다." }, { status: 502 });
    }

    return NextResponse.json({ summary, suggestedRules });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini 호출에 실패했습니다.";
    console.error("[insight]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
