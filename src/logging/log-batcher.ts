import {
  type TaskContext,
  type ToolExecutionRecord,
} from "../domain/task.js";

export interface LogBatcherOptions {
  maxSteps: number;
  maxAgeMs: number;
  immediateKeywords: string[];
  now?: () => number;
}

export interface LogBatch {
  taskInstruction: string;
  conversationHistory: string[];
  batch: ToolExecutionRecord[];
  triggeredBy: "steps" | "time" | "risk" | "manual";
}

type BatchListener = (batch: LogBatch) => void;

export class LogBatcher {
  private readonly pending: ToolExecutionRecord[] = [];
  private readonly listeners = new Set<BatchListener>();
  private readonly now: () => number;
  private lastFlushAt: number;

  constructor(
    private readonly context: TaskContext,
    private readonly options: LogBatcherOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.lastFlushAt = this.now();
  }

  add(record: ToolExecutionRecord): LogBatch | null {
    this.pending.push(this.decorateRisk(record));

    if (this.pending.length >= this.options.maxSteps) {
      return this.flush("steps");
    }

    const latest = this.pending[this.pending.length - 1];
    if ((latest.riskKeywords?.length ?? 0) > 0) {
      return this.flush("risk");
    }

    return this.flushIfDue();
  }

  flushIfDue(): LogBatch | null {
    if (this.pending.length === 0) {
      return null;
    }

    if (this.now() - this.lastFlushAt >= this.options.maxAgeMs) {
      return this.flush("time");
    }

    return null;
  }

  flush(triggeredBy: LogBatch["triggeredBy"] = "manual"): LogBatch | null {
    if (this.pending.length === 0) {
      return null;
    }

    const batch: LogBatch = {
      taskInstruction: this.context.instruction.text,
      conversationHistory: this.context.conversationHistory.map((turn) => turn.text),
      batch: this.pending.splice(0, this.pending.length),
      triggeredBy,
    };

    this.lastFlushAt = this.now();
    for (const listener of this.listeners) {
      listener(batch);
    }

    return batch;
  }

  toJson(batch: LogBatch): string {
    return JSON.stringify(batch.batch, null, 2);
  }

  subscribe(listener: BatchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private decorateRisk(record: ToolExecutionRecord): ToolExecutionRecord {
    const riskKeywords = this.options.immediateKeywords.filter((keyword) =>
      `${record.input} ${JSON.stringify(record.output)}`.includes(keyword),
    );

    return {
      ...record,
      riskKeywords: riskKeywords.length > 0 ? riskKeywords : undefined,
    };
  }
}
