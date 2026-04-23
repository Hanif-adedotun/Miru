import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { config, hasSupabaseConfig } from "./config.js";
import { createId } from "./utils.js";
import type { PersistedPlan } from "./types.js";

interface MiruSessionRow {
  id: string;
  prompt: string;
  mode: string;
  origin: string;
  latest_url: string;
  latest_title: string;
  latest_context: unknown;
  updated_at?: string;
}

interface MiruPlanRow {
  id?: string;
  session_id: string;
  prompt: string;
  mode: string;
  context: unknown;
  proposed_action: unknown;
}

export interface StorageAdapter {
  isPersistent(): boolean;
  upsertSession(plan: PersistedPlan): Promise<string>;
  savePlan(plan: PersistedPlan): Promise<void>;
  getPlanCount(sessionId: string): Promise<number>;
}

class InMemoryStorage implements StorageAdapter {
  private sessions = new Map<string, PersistedPlan>();
  private plans = new Map<string, PersistedPlan[]>();

  isPersistent(): boolean {
    return false;
  }

  async upsertSession(plan: PersistedPlan): Promise<string> {
    const sessionId = plan.sessionId || createId();
    this.sessions.set(sessionId, { ...plan, sessionId });
    return sessionId;
  }

  async savePlan(plan: PersistedPlan): Promise<void> {
    const items = this.plans.get(plan.sessionId) ?? [];
    items.push(plan);
    this.plans.set(plan.sessionId, items);
  }

  async getPlanCount(sessionId: string): Promise<number> {
    return (this.plans.get(sessionId) ?? []).length;
  }
}

class SupabaseStorage implements StorageAdapter {
  constructor(private readonly client: SupabaseClient) {}

  isPersistent(): boolean {
    return true;
  }

  async upsertSession(plan: PersistedPlan): Promise<string> {
    const sessionId = plan.sessionId || createId();
    const origin = new URL(plan.context.url).origin;

    const payload: MiruSessionRow = {
      id: sessionId,
      prompt: plan.prompt,
      mode: plan.mode,
      origin,
      latest_url: plan.context.url,
      latest_title: plan.context.title,
      latest_context: plan.context,
    };

    const { error } = await this.client.from("miru_sessions").upsert(payload);
    if (error) {
      throw new Error(`Failed to upsert miru session: ${error.message}`);
    }

    return sessionId;
  }

  async savePlan(plan: PersistedPlan): Promise<void> {
    const payload: MiruPlanRow = {
      session_id: plan.sessionId,
      prompt: plan.prompt,
      mode: plan.mode,
      context: plan.context,
      proposed_action: plan.proposedAction,
    };

    const { error } = await this.client.from("miru_plans").insert(payload);
    if (error) {
      throw new Error(`Failed to save miru plan: ${error.message}`);
    }
  }

  async getPlanCount(sessionId: string): Promise<number> {
    const { count, error } = await this.client
      .from("miru_plans")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId);

    if (error) {
      throw new Error(`Failed to count miru plans: ${error.message}`);
    }

    return count ?? 0;
  }
}

export function createStorageAdapter(): StorageAdapter {
  if (!hasSupabaseConfig()) {
    return new InMemoryStorage();
  }

  const client = createClient(config.supabaseUrl!, config.supabaseServiceRoleKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return new SupabaseStorage(client);
}
