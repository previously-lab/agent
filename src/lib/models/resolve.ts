import { FIXED_MODEL, type ModelConfig } from "./registry";
/** Legacy persisted IDs are accepted but never select a provider. */
export async function resolveModelById(_id: string): Promise<ModelConfig> { return FIXED_MODEL; }
export async function resolveMainModelFromConfig(): Promise<ModelConfig> { return FIXED_MODEL; }
