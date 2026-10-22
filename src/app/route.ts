import { readFile } from "node:fs/promises";
import path from "node:path";

import { getPublicAuthConfig } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const CONFIG_MARKER = "<!--PINCETTE_CONFIG-->";

export async function GET() {
  const html = await readFile(path.join(process.cwd(), "ui", "index.html"), "utf8");
  const config = JSON.stringify({ auth: getPublicAuthConfig() }).replace(/</g, "\\u003c");
  return new Response(html.replace(CONFIG_MARKER, `<script>window.PINCETTE_CONFIG = ${config};</script>`), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
