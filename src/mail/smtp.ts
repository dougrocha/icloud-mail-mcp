import { connect } from "cloudflare:sockets";
import { base64 } from "./bytes";
import { errorMessage } from "./errors";
import type { Creds } from "./imap";

type SmtpStage = "connect" | "starttls" | "auth" | "mail-from" | "rcpt-to" | "data";

type SmtpOutcome =
  | { readonly kind: "accepted"; readonly reply: string }
  | { readonly kind: "rejected"; readonly stage: SmtpStage; readonly code: number | null; readonly reply: string }
  | { readonly kind: "unknown"; readonly reason: string };

const SMTP_HOST = "smtp.mail.me.com";
const SMTP_PORT = 587;

class Rejected extends Error {
  constructor(
    readonly stage: SmtpStage,
    readonly code: number | null,
    readonly reply: string,
  ) {
    super(reply);
  }
}

interface Reply {
  readonly code: number;
  readonly text: string;
}

class Session {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = "";
  private readonly dec = new TextDecoder();
  private readonly enc = new TextEncoder();

  constructor(
    private socket: Socket,
    private readonly deadline: number,
  ) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  private remaining(): number {
    const ms = this.deadline - Date.now();
    if (ms <= 0) throw new Error("SMTP timeout");
    return ms;
  }

  private async withDeadline<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("SMTP timeout")), this.remaining());
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** RFC 5321 multi-line reply: "250-..." continues, "250 ..." ends. */
  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      let nl = this.buf.indexOf("\r\n");
      while (nl < 0) {
        const { value, done } = await this.withDeadline(this.reader.read());
        if (done) throw new Error("connection closed by server");
        this.buf += this.dec.decode(value, { stream: true });
        nl = this.buf.indexOf("\r\n");
      }
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 2);
      // RFC 5321 4.2: the last line may be the bare code, with no separator or text.
      const m = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!m) throw new Error("malformed SMTP reply");
      lines.push(m[3] ?? "");
      if (m[2] !== "-") return { code: Number(m[1]), text: lines.join("\n") };
    }
  }

  async write(data: string | Uint8Array): Promise<void> {
    await this.withDeadline(this.writer.write(typeof data === "string" ? this.enc.encode(data) : data));
  }

  async expect(stage: SmtpStage, ok: (code: number) => boolean): Promise<Reply> {
    let r: Reply;
    try {
      r = await this.reply();
    } catch (e) {
      throw new Rejected(stage, null, errorMessage(e));
    }
    if (!ok(r.code)) throw new Rejected(stage, r.code, r.text.slice(0, 300));
    return r;
  }

  async cmd(stage: SmtpStage, line: string, ok: (code: number) => boolean): Promise<Reply> {
    try {
      await this.write(`${line}\r\n`);
    } catch (e) {
      throw new Rejected(stage, null, errorMessage(e));
    }
    return this.expect(stage, ok);
  }

  upgrade(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = this.socket.startTls();
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buf = "";
  }

  close(): void {
    this.socket.close().catch(() => {});
  }
}

/**
 * Dot-stuff for DATA and force CRLF line ends: a bare LF or CR in a draft written elsewhere could otherwise
 * end the message early (SMTP smuggling). Ends with exactly one CRLF before the terminating ".".
 */
function* dataChunks(wire: Uint8Array, chunkBytes = 65536): Generator<Uint8Array> {
  // Each input byte becomes at most two output bytes (a doubled dot, or a bare CR/LF turned into CRLF).
  const out = new Uint8Array(chunkBytes * 2 + 2);
  let n = 0;
  let lineStart = true;
  for (let i = 0; i < wire.length; i++) {
    const b = wire[i]!;
    if (lineStart && b === 0x2e) out[n++] = 0x2e;
    lineStart = false;
    if (b === 0x0d || b === 0x0a) {
      if (b === 0x0d && wire[i + 1] === 0x0a) i++;
      out[n++] = 0x0d;
      out[n++] = 0x0a;
      lineStart = true;
    } else out[n++] = b;
    if (n >= chunkBytes) {
      yield out.slice(0, n);
      n = 0;
    }
  }
  if (!lineStart) {
    out[n++] = 0x0d;
    out[n++] = 0x0a;
  }
  if (n) yield out.slice(0, n);
}

const is2xx = (c: number) => c >= 200 && c < 300;

export async function sendRaw(
  acct: Creds,
  env: { readonly from: string; readonly recipients: readonly string[] },
  wire: Uint8Array,
  opts?: { readonly timeoutMs?: number },
): Promise<SmtpOutcome> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 60_000);
  let session: Session | undefined;
  let bodyWritten = false;
  try {
    const socket = connect({ hostname: SMTP_HOST, port: SMTP_PORT }, { secureTransport: "starttls", allowHalfOpen: false });
    session = new Session(socket, deadline);
    const s = session;

    await s.expect("connect", (c) => c === 220);
    await s.cmd("connect", "EHLO icloud-mail-mcp", is2xx);
    await s.cmd("starttls", "STARTTLS", (c) => c === 220);
    s.upgrade();
    await s.cmd("starttls", "EHLO icloud-mail-mcp", is2xx);
    const token = base64(new TextEncoder().encode(`\0${acct.user}\0${acct.pass}`));
    await s.cmd("auth", `AUTH PLAIN ${token}`, (c) => c === 235);
    await s.cmd("mail-from", `MAIL FROM:<${env.from}>`, is2xx);
    for (const r of env.recipients) await s.cmd("rcpt-to", `RCPT TO:<${r}>`, is2xx);
    await s.cmd("data", "DATA", (c) => c === 354);

    try {
      for (const chunk of dataChunks(wire)) await s.write(chunk);
      bodyWritten = true;
      await s.write(".\r\n");
    } catch (e) {
      return { kind: "unknown", reason: errorMessage(e) };
    }

    let final: Reply;
    try {
      final = await s.reply();
    } catch (e) {
      return { kind: "unknown", reason: errorMessage(e) };
    }
    if (!is2xx(final.code)) return { kind: "rejected", stage: "data", code: final.code, reply: final.text.slice(0, 300) };
    await s.write("QUIT\r\n").catch(() => {});
    return { kind: "accepted", reply: final.text.slice(0, 300) };
  } catch (e) {
    if (e instanceof Rejected) return { kind: "rejected", stage: e.stage, code: e.code, reply: e.reply };
    if (bodyWritten) return { kind: "unknown", reason: errorMessage(e) };
    return { kind: "rejected", stage: "connect", code: null, reply: errorMessage(e) };
  } finally {
    session?.close();
  }
}
