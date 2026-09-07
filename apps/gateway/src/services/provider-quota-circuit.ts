export interface QuotaRequestShape {
  promptTokens: number;
  maximumOutputTokens: number;
}

export interface QuotaTicket {
  epoch: number;
  recovery: boolean;
  shape: QuotaRequestShape;
}

export interface ProviderQuotaState {
  state: "closed" | "open" | "half_open";
  epoch: number;
  blockedUntil: number | null;
  requiredRequest: QuotaRequestShape | null;
}

/** Process-local, member/account-scoped. No background traffic or persisted secrets. */
export class ProviderQuotaCircuit {
  private epoch = 0;
  private required: QuotaRequestShape | null = null;
  private probe: QuotaTicket | null = null;
  private until = 0;

  constructor(private readonly cooldownMs: number, private readonly now: () => number) {}

  get blockedUntil(): number | null { return this.required ? this.until : null; }

  snapshot(): ProviderQuotaState {
    return { state: !this.required ? "closed" : this.probe ? "half_open" : "open",
      epoch: this.epoch, blockedUntil: this.blockedUntil,
      requiredRequest: this.required ? { ...this.required } : null };
  }

  allows(shape?: QuotaRequestShape): boolean {
    if (!this.required) return true;
    return !this.probe && this.now() >= this.until && !!shape &&
      shape.promptTokens >= this.required.promptTokens &&
      shape.maximumOutputTokens >= this.required.maximumOutputTokens;
  }

  begin(shape: QuotaRequestShape): QuotaTicket {
    if (!this.allows(shape)) throw new Error("Quota recovery request is not eligible.");
    const recovery = this.required !== null;
    const ticket = { epoch: this.epoch, recovery, shape: { ...shape } };
    if (recovery) this.probe = ticket;
    return ticket;
  }

  finish(ticket: QuotaTicket, outcome: "success" | "quota" | "other"): void {
    if (this.probe === ticket) this.probe = null;
    if (outcome === "quota") {
      this.epoch += 1;
      this.required = {
        promptTokens: Math.max(this.required?.promptTokens ?? 0, ticket.shape.promptTokens),
        maximumOutputTokens: Math.max(this.required?.maximumOutputTokens ?? 0, ticket.shape.maximumOutputTokens)
      };
      this.until = this.now() + this.cooldownMs;
      return;
    }
    if (ticket.epoch !== this.epoch || !ticket.recovery) return;
    if (outcome === "success") {
      this.required = null;
      this.until = 0;
    } else {
      this.until = this.now() + this.cooldownMs;
    }
  }
}

export function quotaCooldownMs(value: string | undefined): number | undefined {
  if (!value || value === "0") return undefined;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
    throw new Error("GATEWAY_GOLDENCODE_QUOTA_COOLDOWN_SECONDS must be an integer from 0 to 86400.");
  }
  return seconds * 1000;
}
