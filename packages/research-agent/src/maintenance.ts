export class ResearchMaintenanceGate {
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  async run<T>(
    operation: () => T | Promise<T>
  ): Promise<
    | { outcome: "completed"; value: T }
    | { outcome: "skipped_already_running" }
  > {
    if (this.running) {
      return { outcome: "skipped_already_running" };
    }
    this.running = true;
    try {
      return {
        outcome: "completed",
        value: await operation()
      };
    } finally {
      this.running = false;
    }
  }
}
