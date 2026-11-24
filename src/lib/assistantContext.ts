export interface AssistantContext {
  source: string;
  text: string;
}

let current: AssistantContext | null = null;
const listeners = new Set<(context: AssistantContext | null) => void>();

export function setAssistantContext(source: string, text: string | null): void {
  const content = text?.trim();
  if (content) {
    if (current?.source === source && current.text === content) return;
    current = { source, text: content };
  } else {
    if (current?.source !== source) return;
    current = null;
  }
  for (const listener of listeners) listener(current);
}

export function getAssistantContext(): AssistantContext | null {
  return current;
}

export function subscribeAssistantContext(listener: (context: AssistantContext | null) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
