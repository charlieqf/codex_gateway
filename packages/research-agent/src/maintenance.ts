export class ResearchMaintenanceGate {
  private active: Promise<unknown> | null = null;

  get isRunning(): boolean {
    return this.active !== null;
  }

  async run<T>(
    operation: () => T | Promise<T>
  ): Promise<
    | { outcome: "completed"; value: T }
    | { outcome: "skipped_already_running" }
  > {
    if (this.active) {
      return { outcome: "skipped_already_running" };
    }
    const active = Promise.resolve().then(operation);
    this.active = active;
    try {
      return {
        outcome: "completed",
        value: await active
      };
    } finally {
      if (this.active === active) {
        this.active = null;
      }
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.active) {
      await this.active;
    }
  }
}
