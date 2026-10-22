import { NextResponse } from "next/server";

import { canEncrypt, decryptSecret, encryptSecret } from "@/lib/secret-box";
import { AuthError, getUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_STATE_BYTES = 3_000_000;

type Row = { state: Record<string, unknown> | null; api_key_enc: string | null; updated_at: string };

function toPayload(row: Row | null) {
  if (!row) return { state: null, updatedAt: null, apiKeySync: canEncrypt() };
  const state: Record<string, unknown> = { ...(row.state || {}) };
  const apiKey = decryptSecret(row.api_key_enc);
  if (apiKey !== null) state.apiKey = apiKey;
  else delete state.apiKey;
  return { state, updatedAt: row.updated_at, apiKeySync: canEncrypt() };
}

function failure(error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[state]", error instanceof Error ? error.message : error);
  return NextResponse.json({ error: "계정 데이터를 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }, { status: 502 });
}

export async function GET(request: Request) {
  try {
    const { client, userId } = await getUserClient(request);
    const { data, error } = await client
      .from("user_state")
      .select("state, api_key_enc, updated_at")
      .eq("user_id", userId)
      .maybeSingle<Row>();
    if (error) throw new Error(error.message);
    return NextResponse.json(toPayload(data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const { client, userId } = await getUserClient(request);

    const text = await request.text();
    if (text.length > MAX_STATE_BYTES) {
      return NextResponse.json({ error: "저장할 데이터가 너무 큽니다. 오래된 기록을 정리해 주세요." }, { status: 413 });
    }
    let body: { state?: unknown; baseUpdatedAt?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "요청 본문이 올바른 JSON이 아닙니다." }, { status: 400 });
    }
    if (!body.state || typeof body.state !== "object" || Array.isArray(body.state)) {
      return NextResponse.json({ error: "저장할 데이터 형식이 올바르지 않습니다." }, { status: 400 });
    }

    const { apiKey, ...state } = body.state as Record<string, unknown>;
    const baseUpdatedAt = typeof body.baseUpdatedAt === "string" ? body.baseUpdatedAt : null;
    const updatedAt = new Date().toISOString();

    const values: Record<string, unknown> = { state, updated_at: updatedAt };
    if (typeof apiKey === "string" && canEncrypt()) {
      values.api_key_enc = apiKey.trim() ? encryptSecret(apiKey.trim()) : null;
    }

    const write = baseUpdatedAt
      ? client
          .from("user_state")
          .update(values)
          .eq("user_id", userId)
          .eq("updated_at", baseUpdatedAt)
          .select("updated_at")
      : client
          .from("user_state")
          .insert({ user_id: userId, ...values })
          .select("updated_at");

    const { data, error } = await write;
    if (error && error.code !== "23505") throw new Error(error.message);

    if (!error && data && data.length > 0) {
      return NextResponse.json({ updatedAt: data[0].updated_at, apiKeySync: canEncrypt() });
    }

    // Another device saved first: hand back the newer copy instead of overwriting it.
    const current = await client
      .from("user_state")
      .select("state, api_key_enc, updated_at")
      .eq("user_id", userId)
      .maybeSingle<Row>();
    if (current.error) throw new Error(current.error.message);
    return NextResponse.json(
      { error: "다른 기기에서 먼저 저장된 데이터가 있습니다.", conflict: true, ...toPayload(current.data) },
      { status: 409 },
    );
  } catch (error) {
    return failure(error);
  }
}
