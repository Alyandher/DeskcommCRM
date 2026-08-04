import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * GET /auth/confirm — troca o token do e-mail (token_hash) por uma sessão.
 *
 * É o destino único dos links de e-mail do GoTrue (templates customizados em
 * supabase/templates/): confirmação de signup E redefinição de senha.
 *
 * - type=signup  → provisiona o tenant (org + membership admin) e entra no
 *                  onboarding. Provisionamento é idempotente (link clicado 2x).
 * - type=recovery → sessão de recovery estabelecida; segue para /login/reset
 *                  onde o usuário define a senha nova.
 *
 * Fluxo canônico do @supabase/ssr: verifyOtp grava os cookies de sessão via
 * cookies() do next/headers; o Next anexa os Set-Cookie ao redirect retornado.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const requestId = request.headers.get("x-request-id");

  // NUNCA use `url.origin` (request.nextUrl.origin) como base aqui: em standalone
  // (self-host atrás de reverse proxy) o Next.js Node runtime resolve `nextUrl`
  // pelo endereço de bind do servidor (HOSTNAME/PORT do Dockerfile, ex.
  // 0.0.0.0:3000), não pelo Host público encaminhado pelo proxy — confirmado ao
  // vivo (redirect batia em https://0.0.0.0:3000/login?error=link_invalido).
  // `env.NEXT_PUBLIC_APP_URL` é a fonte confiável (lida em runtime, não
  // embutida no build — ver Dockerfile/lib/env.ts) e já é o padrão usado em
  // app/api/v1/integrations/nuvemshop/callback/route.ts para o mesmo problema.
  const redirectTo = (path: string) =>
    NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));

  if (!tokenHash || !type) {
    return redirectTo("/login?error=link_invalido");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error || !data.user) {
    await audit({
      action: "auth.email_link_rejected",
      metadata: { type, reason: error?.message ?? "no_user" },
      requestId,
    });
    return redirectTo("/login?error=link_invalido");
  }

  if (type === "recovery") {
    return redirectTo("/login/reset");
  }

  try {
    await ensureTenantForUser(data.user);
  } catch (e) {
    await audit({
      action: "auth.signup_provision_failed",
      actorUserId: data.user.id,
      metadata: { reason: e instanceof Error ? e.message : String(e) },
      requestId,
    });
    return redirectTo("/login?error=provisionamento");
  }

  void audit({
    action: "auth.signup_confirmed",
    actorUserId: data.user.id,
    metadata: {},
    requestId,
  });

  return redirectTo("/onboarding/welcome");
}
