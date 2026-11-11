import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { CAPABILITIES, CAPABILITY_IDS, Grant, labelForScope } from "./capabilities";

interface ConsentSubmission {
  readonly handle: string;
  readonly decision: "approve" | "deny";
  readonly passphrase: string;
  readonly grant: Grant;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function capabilityRows(): string {
  return CAPABILITY_IDS.map((id) => {
    const c: { label: string; can: string; cannot: string; implied?: true; sensitive?: true } = CAPABILITIES[id];
    // Browsers do not submit disabled checkboxes.
    const attrs = c.implied ? "checked disabled" : "";
    return `<label class="cap${c.sensitive ? " warn" : ""}"><input type="checkbox" name="cap" value="${esc(id)}" ${attrs}>
<span><b>${esc(c.label)}</b>${c.implied ? " (always on)" : ""}<small>${esc(c.can)}</small><small class="muted">${esc(c.cannot)}</small></span></label>`;
  }).join("\n");
}

export function renderConsentPage(d: ConsentDescription, handle: string): string {
  const name = esc(d.clientName);
  const asked = d.scope.map((s) => esc(labelForScope(s))).join(", ") || "nothing specific";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize ${name}</title>
<style>body{font:15px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.5rem}input[type=password]{width:100%;box-sizing:border-box}
fieldset{border:1px solid #8886;border-radius:.5rem;margin:1rem 0;padding:.5rem 1rem}label.cap{display:flex;gap:.6rem;align-items:flex-start;margin:.7rem 0}label.cap input{margin-top:.35rem;padding:0}
small{display:block;font-size:.85em}.muted{opacity:.65}.warn b{color:#b45309}</style>
<h2>Allow ${name} to use your iCloud Mail?</h2>
<p>${d.clientDomain ? `Published by <b>${esc(d.clientDomain)}</b>.` : "This app registered itself; its name is not verified."}
Access goes to <b>${esc(d.redirectHost)}</b>.</p>
${d.redirectIsLoopback ? "<p><b>This sends access to an app on your computer.</b> Continue only if you just started signing in from it.</p>" : ""}
<form method="post">
<fieldset><legend>What may it do?</legend>
${capabilityRows()}
</fieldset>
<p class="muted">The app asked for: ${asked}. The app cannot see or use anything you leave unticked. To change this later, disconnect and reconnect.</p>
<input type="hidden" name="handle" value="${esc(handle)}">
<p><input type="password" name="passphrase" placeholder="Server passphrase" autocomplete="current-password" autofocus></p>
<p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

export function readConsentForm(form: FormData): ConsentSubmission {
  return {
    handle: String(form.get("handle") ?? ""),
    decision: form.get("decision") === "approve" ? "approve" : "deny",
    passphrase: String(form.get("passphrase") ?? ""),
    grant: Grant.fromConsent(form.getAll("cap")),
  };
}
