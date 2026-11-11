import { expect, test } from "bun:test";
import type { ListResponse } from "imapflow";
import { concatBytes } from "../src/mail/bytes";
import { Folders } from "../src/mail/folders";
import { tryAddress } from "../src/mail/mime";

const box = (path: string, flags: string[] = []) => ({ path, flags: new Set(flags) }) as unknown as ListResponse;
const folders = Folders.fromListing([box("INBOX"), box("Sent Messages", ["\\Sent"]), box("Notes"), box("Notes/Work")]);

test("resolve accepts roles and exact paths", () => {
  expect(folders.resolve("sent")).toBe("Sent Messages");
  expect(folders.resolve("INBOX")).toBe("INBOX");
});

test("resolve refuses Apple Notes by path", () => {
  expect(() => folders.resolve("Notes")).toThrow("Apple Notes");
  expect(() => folders.resolve("Notes/Work")).toThrow("Apple Notes");
});

test("tryAddress drops invalid addresses and unusable names instead of throwing", () => {
  expect(tryAddress({ address: "not an address" })).toBeNull();
  expect(tryAddress({ name: "Bob", address: undefined })).toBeNull();
  expect(tryAddress({ name: "Bob", address: "bob@example.com" })).toEqual({ name: "Bob", address: "bob@example.com" });
  expect(tryAddress({ name: "Bo\r\nb", address: "bob@example.com" })).toEqual({ address: "bob@example.com" });
});

test("concatBytes joins parts in order", () => {
  expect([...concatBytes(new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([3]))]).toEqual([1, 2, 3]);
});
