import { expect, test } from "bun:test";
import { CAPABILITY_IDS, Grant } from "../src/capabilities";

test("an empty scope list grants nothing, not even read", () => {
  const g = Grant.fromScopes([]);
  expect(g.has("read")).toBe(false);
  expect(g.capabilities).toEqual([]);
  expect(g.toScopes()).toEqual([]);
});

test("missing scopes grant nothing", () => {
  expect(Grant.fromScopes(undefined).capabilities).toEqual([]);
});

test("mail:draft alone grants the draft capability but no read and no other tools", () => {
  const g = Grant.fromScopes(["mail:draft"]);
  expect(g.capabilities).toEqual(["draft"]);
  expect(g.has("read")).toBe(false);
  for (const c of CAPABILITY_IDS) if (c !== "draft") expect(g.has(c)).toBe(false);
});

test("unknown scopes are ignored", () => {
  expect(Grant.fromScopes(["mail:admin", "openid"]).capabilities).toEqual([]);
});

test("consent always implies read, even with nothing ticked", () => {
  expect(Grant.fromConsent([]).capabilities).toEqual(["read"]);
});

test("consent adds ticked capabilities and ignores unknown or non-string values", () => {
  const g = Grant.fromConsent(["send", "bogus", 42, new File([], "x")]);
  expect(g.capabilities).toEqual(["read", "send"]);
  expect(g.toScopes()).toEqual(["mail:read", "mail:send"]);
});
