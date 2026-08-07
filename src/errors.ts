export type NexusErrorCode =
  | "UNSUPPORTED_CHAIN"
  | "UNSUPPORTED_ADAPTER"
  | "UNSUPPORTED_CAPABILITY"
  | "INVALID_ARGUMENT"
  | "INVALID_TOKEN_METADATA"
  | "INVALID_PLAN"
  | "PLAN_CHANGED"
  | "DEPLOYMENT_CODE_MISMATCH"
  | "PROTOCOL_CONFIG_CHANGED"
  | "PROTOCOL_NOT_READY"
  | "INSUFFICIENT_FUNDS"
  | "SIMULATION_REVERTED"
  | "WALLET_REJECTED"
  | "TRANSACTION_REVERTED"
  | "RECEIPT_NOT_FOUND"
  | "LAUNCH_VERIFICATION_FAILED"
  | "METADATA_UPLOAD_FAILED"
  | "RPC_ERROR";

export class NexusError extends Error {
  readonly code: NexusErrorCode;
  readonly broadcast: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly recovery: string | undefined;
  override readonly cause: unknown;

  constructor(
    code: NexusErrorCode,
    message: string,
    options: {
      broadcast?: boolean;
      cause?: unknown;
      details?: Readonly<Record<string, unknown>>;
      recovery?: string;
    } = {},
  ) {
    super(message);
    this.name = "NexusError";
    this.code = code;
    this.broadcast = options.broadcast ?? false;
    this.cause = options.cause;
    this.details = options.details;
    this.recovery = options.recovery;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      broadcast: this.broadcast,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.recovery === undefined ? {} : { recovery: this.recovery }),
    };
  }
}

export function toNexusError(error: unknown, fallbackCode: NexusErrorCode = "RPC_ERROR"): NexusError {
  if (error instanceof NexusError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NexusError(fallbackCode, message, { cause: error });
}
