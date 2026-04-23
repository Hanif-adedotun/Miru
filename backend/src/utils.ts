import crypto from "node:crypto";

export function createId(): string {
  return crypto.randomUUID();
}

export function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}...`;
}
