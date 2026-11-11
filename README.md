# icloud-mail-mcp

MCP server for iCloud Mail on a Cloudflare Worker. A client can only read mail unless you tick more permissions on the consent page.

| Grant | Tools |
| --- | --- |
| read (always) | `list_folders`, `search_messages`, `read_message`. Reading never marks mail as read. |
| draft | `save_draft` (new, reply, reply-all, forward, edit) and `delete_draft`, for drafts this server created. |
| send | `send_draft`, which sends an existing draft by uid. |
| organize | `mark_messages` and `move_messages` (archive, trash, junk). Nothing is permanently deleted. |
| attachments | `get_attachment`: images, text, PDF text, or base64, up to 10 MB. |

A client sees only the tools it was granted. To change a grant, disconnect and reconnect.

## Local setup

You need [Bun](https://bun.sh), [mkcert](https://github.com/FiloSottile/mkcert) (`brew install mkcert`) and an iCloud app-specific password from [account.apple.com](https://account.apple.com) (Sign-In and Security, then App-Specific Passwords).

```sh
bun install
cp .dev.vars.example .dev.vars    # fill in your iCloud address, the app password and a long random passphrase
mkcert -install
mkdir -p .certs && mkcert -cert-file .certs/localhost.pem -key-file .certs/localhost-key.pem localhost
bun run dev                       # https://localhost:8787/mcp
claude mcp add --transport http icloud https://localhost:8787/mcp
```

Connecting opens the consent page, where you tick permissions and enter the passphrase. Node-based clients such as Claude Code need `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` to trust the local certificate. Local dev uses HTTPS because Safari drops the `Secure` consent cookie on plain `http://localhost`.

`./test-e2e.sh .dev.vars` checks, while dev is running, that each grant shows and allows only its tools.

## Deploy

```sh
bunx wrangler secret put ICLOUD_USER
bunx wrangler secret put ICLOUD_APP_PASSWORD
bunx wrangler secret put AUTH_PASSPHRASE
```

Set `MCP_RESOURCE` in `wrangler.jsonc` to `https://icloud-mail-mcp.<you>.workers.dev/mcp`, then run `bun run deploy`. In Claude, add a custom connector with that URL.

## Attachments from the terminal

`icloud-mail-attachment` saves attachments straight to your Mac, so Claude Code can open large PDFs with its own reader.

```sh
ln -s "$PWD/src/cli/attachment.ts" ~/.local/bin/icloud-mail-attachment
icloud-mail-attachment inbox 1234 2    # one part, ids from read_message
icloud-mail-attachment inbox 1234      # every attachment
# prints: /Users/you/Downloads/icloud-mail/INBOX/1234/2-invoice.pdf
```

It is read-only and uses the credentials in `.dev.vars`. The limit is 50 MB per file.

## Notes

- Anyone with the passphrase can grant themselves access to your inbox, so make it long and random. On a deployed server, consider putting Cloudflare Access in front of `/authorize`.
- `send_draft` never sends twice. It marks the draft before sending, and a retry checks Sent first. Bcc is never sent to recipients and stays only in your Sent copy.
- PDF text extraction needs more CPU than the Workers free plan allows. Use `icloud-mail-attachment` instead.

## License

MIT. Not affiliated with or endorsed by Apple. iCloud is a trademark of Apple Inc.
