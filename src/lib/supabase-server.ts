import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type PublicAuthConfig = { supabaseUrl: string; supabaseAnonKey: string };

export function getPublicAuthConfig(): PublicAuthConfig | null {
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const supabaseAnonKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    ""
  ).trim();
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return { supabaseUrl, supabaseAnonKey };
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// The client carries the user's own access token, so every query runs under that user's RLS policies.
export async function getUserClient(request: Request): Promise<{ client: SupabaseClient; userId: string }> {
  const config = getPublicAuthConfig();
  if (!config) throw new AuthError("로그인 기능이 아직 설정되지 않았습니다.", 503);

  const header = request.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AuthError("로그인이 필요합니다.", 401);

  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new AuthError("로그인이 만료되었습니다. 다시 로그인해 주세요.", 401);

  return { client, userId: data.user.id };
}
