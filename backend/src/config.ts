import "./loadEnv.js";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export interface BackendConfig {
  host: string;
  port: number;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  groqApiKey?: string;
  groqModel: string;
}

export const config: BackendConfig = {
  host: readEnv("HOST") ?? "0.0.0.0",
  port: Number(readEnv("PORT") ?? "3001"),
  supabaseUrl: readEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: readEnv("SUPABASE_SERVICE_ROLE_KEY"),
  groqApiKey: readEnv("GROQ_API_KEY"),
  groqModel: readEnv("GROQ_MODEL") ?? "openai/gpt-oss-120b",
};

export function hasSupabaseConfig(): boolean {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}

export function hasGroqConfig(): boolean {
  return Boolean(config.groqApiKey);
}
