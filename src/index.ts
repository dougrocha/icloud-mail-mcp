import {
  AuthorizationError,
  CimdFetchError,
  GrantType,
  OAuthProvider,
  type OAuthHelpers,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env as moduleEnv } from "cloudflare:workers";
import { REQUIRED_SCOPES, SCOPES_SUPPORTED } from "./capabilities";
import { readConsentForm, renderConsentPage } from "./consent";
import { createServer } from "./server";

const OWNER = "owner";
const MIN_PASSPHRASE = 16;

type AppEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const mcpHandler = createMcpHandler(createServer);

async function safeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

const text = (msg: string, status: number) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const authHandler: ExportedHandler<AppEnv> = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/authorize") return text("iCloud Mail MCP. Connect your client to /mcp.", 404);
    if ((env.AUTH_PASSPHRASE ?? "").length < MIN_PASSPHRASE) {
      return text(`Server misconfigured: set AUTH_PASSPHRASE (at least ${MIN_PASSPHRASE} characters).`, 503);
    }
    const oauth = env.OAUTH_PROVIDER;

    try {
      if (req.method === "GET") {
        const request = await oauth.parseAuthRequest(req);
        const details = await oauth.describeConsent(request);
        const consent = await oauth.beginConsent(request);
        consent.headers.set("Content-Type", "text/html; charset=utf-8");
        return new Response(renderConsentPage(details, consent.handle), { headers: consent.headers });
      }

      if (req.method === "POST") {
        const sub = readConsentForm(await req.formData());

        if (sub.decision !== "approve") {
          const denied = await oauth.denyConsent(req, sub.handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }

        const ip = req.headers.get("cf-connecting-ip") ?? "local";
        const { success } = await env.CONSENT_LIMITER.limit({ key: `passphrase:${ip}` });
        if (!success) return text("Too many attempts. Wait a minute and try again.", 429);

        // approveConsent() consumes the handle, so a wrong passphrase must be rejected before it.
        if (!(await safeEqual(sub.passphrase, env.AUTH_PASSPHRASE))) {
          return text("Wrong passphrase. Go back and try again.", 403);
        }

        const approved = await oauth.approveConsent(req, sub.handle, { scope: sub.grant.toScopes() });
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: OWNER,
          metadata: {},
          scope: approved.request.scope,
          props: { userId: OWNER },
        });
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }

      return text("Method not allowed", 405);
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError) return text(e.description, 400);
      if (e instanceof CimdFetchError) return text("This app could not be verified.", 400);
      throw e;
    }
  },
};

/** The provider downscopes the token to the client's requested scope on code exchange and refresh. */
function pinTokenScopeToGrant(o: TokenExchangeCallbackOptions<AppEnv>): TokenExchangeCallbackResult | undefined {
  if (o.grantType === GrantType.AUTHORIZATION_CODE || o.grantType === GrantType.REFRESH_TOKEN) {
    return { accessTokenScope: o.scope };
  }
  return undefined;
}

const provider = new OAuthProvider<AppEnv>({
  apiRoute: "/mcp",
  apiHandler: { fetch: mcpHandler },
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: [...SCOPES_SUPPORTED],
  requiredScopes: [...REQUIRED_SCOPES],
  tokenExchangeCallback: pinTokenScopeToGrant,
  resourceMetadata: { resource: moduleEnv.MCP_RESOURCE },
});
const RESOURCE_ORIGIN = new URL(moduleEnv.MCP_RESOURCE).origin;

export default {
  fetch(req, env, ctx) {
    const actual = new URL(req.url).origin;
    if (actual !== RESOURCE_ORIGIN) {
      return text(`Server misconfigured: MCP_RESOURCE is ${moduleEnv.MCP_RESOURCE}, but this server is ${actual}. Update it in wrangler.jsonc.`, 500);
    }
    return provider.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
