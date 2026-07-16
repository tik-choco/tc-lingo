import { useEffect, useRef, useState } from "preact/hooks";
import { useConsumerStatus } from "@tik-choco/mistai/preact";
import { networkClient, onConsumerStatusChange, type ConsumerStatus } from "../lib/network";

export type ConsumerStatusWithTimestamp = {
  status: ConsumerStatus;
  /** Timestamp (ms) of the last phase transition, for "接続済み · 14:32" style display. */
  updatedAt: number;
};

/** Tracks the consumer-side LLM Network connection lifecycle for display in the UI. */
export function useNetworkConsumerStatus(): ConsumerStatus {
  return useConsumerStatus(networkClient);
}

/**
 * Same as useNetworkConsumerStatus, but also tracks when the phase last
 * changed so the UI can show a "state last changed at" timestamp alongside
 * the step indicator (未接続 → Room接続中 → provider探索中 → 接続済み/エラー).
 */
export function useNetworkConsumerStatusWithTimestamp(): ConsumerStatusWithTimestamp {
  const [status, setStatus] = useState<ConsumerStatus>(() => networkClient.status);
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());
  const lastPhase = useRef<ConsumerStatus["phase"]>(networkClient.status.phase);

  useEffect(
    () =>
      onConsumerStatusChange((next) => {
        setStatus(next);
        if (next.phase !== lastPhase.current) {
          lastPhase.current = next.phase;
          setUpdatedAt(Date.now());
        }
      }),
    [],
  );

  return { status, updatedAt };
}
