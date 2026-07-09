import Anthropic from "@anthropic-ai/sdk";

// Modelo usado na conciliação. Claude Opus 4.8 é o padrão da Anthropic.
export const RECONCILIATION_MODEL = "claude-opus-4-8";

/**
 * Cria um cliente da API da Anthropic (Claude) usando a variável de ambiente
 * ANTHROPIC_API_KEY. Substitui o antigo gateway do Lovable.
 */
export function createAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY ausente");
  return new Anthropic({ apiKey });
}
