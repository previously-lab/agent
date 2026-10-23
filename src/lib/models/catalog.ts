import { getAvailableModels, type ModelConfig } from "./registry";
/** No remote catalog: the product has one fixed, vision-capable model. */
export async function resolveAvailableModels(): Promise<ModelConfig[]> {
  return getAvailableModels();
}
