interface CapabilityInfo {
  readonly scope: `mail:${string}`;
  readonly label: string;
  readonly can: string;
  readonly cannot: string;
  readonly implied?: true;
  readonly sensitive?: true;
}

export const CAPABILITIES = {
  read: {
    scope: "mail:read",
    label: "Read mail",
    can: "List folders, search and read messages.",
    cannot: "Reading never marks a message as read.",
    implied: true,
  },
  draft: {
    scope: "mail:draft",
    label: "Write drafts",
    can: "Create, edit and delete drafts that this app created, including replies and forwards.",
    cannot: "Drafts stay in your Drafts folder. Nothing is sent.",
  },
  send: {
    scope: "mail:send",
    label: "Send drafts",
    can: "Send a draft that already exists in your Drafts folder.",
    cannot: "Cannot write and send in one step, and cannot send anything that is not a saved draft.",
    sensitive: true,
  },
  organize: {
    scope: "mail:organize",
    label: "Organize mail",
    can: "Mark read/unread, flag, move between folders, archive, move to Trash.",
    cannot: "Cannot permanently delete mail or empty the Trash.",
  },
  attachments: {
    scope: "mail:attachments",
    label: "Download attachments",
    can: "Read attachment contents (up to 10 MB each), e.g. a PDF invoice.",
    cannot: "Cannot attach files to outgoing mail.",
  },
} as const satisfies Record<string, CapabilityInfo>;

export type Capability = keyof typeof CAPABILITIES;
type Scope = (typeof CAPABILITIES)[Capability]["scope"];

export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as readonly Capability[];

export const SCOPES_SUPPORTED: readonly Scope[] = CAPABILITY_IDS.map((c) => CAPABILITIES[c].scope);

/** The provider only advertises these; it does not enforce them. */
export const REQUIRED_SCOPES: readonly Scope[] = CAPABILITY_IDS.filter((c) => "implied" in CAPABILITIES[c]).map(
  (c) => CAPABILITIES[c].scope,
);

const BY_SCOPE: ReadonlyMap<string, Capability> = new Map(CAPABILITY_IDS.map((c) => [CAPABILITIES[c].scope, c]));
const isCapability = (v: string): v is Capability => Object.hasOwn(CAPABILITIES, v);

export const labelForScope = (scope: string): string => {
  const c = BY_SCOPE.get(scope);
  return c ? CAPABILITIES[c].label : scope;
};

export class Grant {
  private constructor(private readonly granted: ReadonlySet<Capability>) {}

  static fromScopes(scopes: readonly string[] | undefined): Grant {
    const out = new Set<Capability>();
    for (const s of scopes ?? []) {
      const c = BY_SCOPE.get(s);
      if (c) out.add(c);
    }
    return new Grant(out);
  }

  static fromConsent(ticked: Iterable<unknown>): Grant {
    const out = new Set<Capability>(CAPABILITY_IDS.filter((c) => "implied" in CAPABILITIES[c]));
    for (const v of ticked) if (typeof v === "string" && isCapability(v)) out.add(v);
    return new Grant(out);
  }

  has(c: Capability): boolean {
    return this.granted.has(c);
  }

  get capabilities(): readonly Capability[] {
    return CAPABILITY_IDS.filter((c) => this.granted.has(c));
  }

  toScopes(): Scope[] {
    return this.capabilities.map((c) => CAPABILITIES[c].scope);
  }
}
