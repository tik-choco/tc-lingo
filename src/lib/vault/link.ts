import { consumeVaultLink } from "@tik-choco/mistvault";

export function takeVaultLink(): string | null {
  try {
    return consumeVaultLink();
  } catch {
    return null;
  }
}
