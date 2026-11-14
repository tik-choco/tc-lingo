import { createMistVaultTransport, createVault } from "@tik-choco/mistvault";
import { storageAdd, storageGet } from "../mistStorage";
import { createAppNode } from "../network";
import { createVaultAdapter } from "./adapter";

export const vault = createVault({
  adapter: createVaultAdapter(),
  transport: () => createMistVaultTransport({ createNode: createAppNode, storageAdd, storageGet }),
});
