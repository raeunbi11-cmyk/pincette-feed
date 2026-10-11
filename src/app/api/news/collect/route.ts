import { NextResponse } from "next/server";

import { CollectInputError, parseCollectInput } from "@/lib/collect-criteria";
import { collectNews } from "@/lib/collect-news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 올바른 JSON이 아닙니다." }, { status: 400 });
  }

  try {
    const input = parseCollectInput(body);
    const result = await collectNews(input);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "기사 수집에 실패했습니다.";
    const status = error instanceof CollectInputError ? 400 : 502;
    console.error("[news/collect]", message);
    return NextResponse.json({ error: message }, { status });
  }
}
