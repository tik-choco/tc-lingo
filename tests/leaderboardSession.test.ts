import { EVENT_PEER_CONNECTED, EVENT_PEER_DISCONNECTED, EVENT_RAW } from "@tik-choco/mistai";
import type { MistNodeLike } from "@tik-choco/mistai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decodeLeaderboard, encodeLeaderboard } from "../src/lib/leaderboard/protocol";
import type { LeaderboardMessage } from "../src/lib/leaderboard/protocol";
import { getLeaderboardState, startLeaderboard, stopLeaderboard } from "../src/lib/leaderboard/session";
import { emptyLlmConfig, saveLlmConfig } from "../src/lib/llmConfig";
import { loadSettings, saveSettings } from "../src/lib/settings";

const { createAppNode } = vi.hoisted(() => ({ createAppNode: vi.fn<() => MistNodeLike>() }));
vi.mock("../src/lib/network", () => ({ createAppNode, NODE_ID_STORAGE_KEY: "leaderboard-test-node" }));

const hello = { type: "lingo_rank_hello", v: 1 } as const;
const peerStats = {
  type: "lingo_rank_stats",
  v: 1,
  name: "Peer",
  language: "Japanese",
  stats: { today: 1, week: 2, month: 3, streak: 1, activeDays: 3 },
  sentAt: 0,
} satisfies LeaderboardMessage;

function fakeTransport(joinRoom = vi.fn<MistNodeLike["joinRoom"]>()) {
  let handler: Parameters<MistNodeLike["onEvent"]>[0] | undefined;
  const node = {
    init: vi.fn(async () => {}),
    onEvent: (next: typeof handler) => { handler = next; },
    joinRoom,
    leaveRoom: vi.fn(),
    sendMessage: vi.fn<MistNodeLike["sendMessage"]>(),
  } satisfies MistNodeLike;
  return {
    node,
    emit: (event: number, id: string, message?: LeaderboardMessage, roomId = "study") => {
      handler?.(event, id, message && encodeLeaderboard(message), roomId);
    },
    sent: () => node.sendMessage.mock.calls.map(([to, payload]) => [to, decodeLeaderboard(payload)]),
  };
}

function setRoom(roomId: string) {
  saveLlmConfig({ ...emptyLlmConfig(), network: { roomId } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 23, 12));
  const values = new Map([["leaderboard-test-node", "self"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  stopLeaderboard();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("requires opt-in and a room, then responds to peers and leaves on opt-out", async () => {
  const transport = fakeTransport();
  createAppNode.mockReturnValueOnce(transport.node);
  startLeaderboard();
  expect(getLeaderboardState().status).toBe("off");
  expect(createAppNode).not.toHaveBeenCalled();

  saveSettings({ ...loadSettings(), leaderboardEnabled: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(getLeaderboardState().status).toBe("no-room");

  setRoom(" study ");
  await vi.advanceTimersByTimeAsync(0);
  expect(transport.node.joinRoom).toHaveBeenCalledWith("study");
  expect(getLeaderboardState()).toMatchObject({ status: "connected", roomId: "study", selfId: "self" });
  expect(transport.sent()).toEqual([
    [null, hello],
    [null, expect.objectContaining({ type: "lingo_rank_stats", name: "" })],
  ]);

  transport.emit(EVENT_PEER_CONNECTED, "new-peer");
  transport.emit(EVENT_RAW, "hello-peer", hello);
  expect(transport.sent().slice(2)).toEqual([
    ["new-peer", expect.objectContaining({ type: "lingo_rank_stats" })],
    ["hello-peer", expect.objectContaining({ type: "lingo_rank_stats" })],
  ]);
  transport.emit(EVENT_RAW, "self", peerStats);
  transport.emit(EVENT_RAW, "foreign-peer", peerStats, "another-room");
  transport.emit(EVENT_RAW, "peer", peerStats);
  expect(getLeaderboardState().peers).toEqual([
    { id: "peer", name: peerStats.name, language: peerStats.language, stats: peerStats.stats, receivedAt: Date.now() },
  ]);
  transport.emit(EVENT_PEER_DISCONNECTED, "peer");
  expect(getLeaderboardState().peers).toEqual([]);

  transport.emit(EVENT_RAW, "peer", peerStats);
  saveSettings({ ...loadSettings(), leaderboardEnabled: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(transport.node.leaveRoom).toHaveBeenCalledOnce();
  expect(getLeaderboardState()).toMatchObject({ status: "off", selfId: null, peers: [] });
  transport.emit(EVENT_RAW, "peer", peerStats);
  expect(getLeaderboardState().peers).toEqual([]);
});

it("debounces writes, refreshes each minute, and expires peers based on receipt time", async () => {
  const transport = fakeTransport();
  createAppNode.mockReturnValueOnce(transport.node);
  setRoom("study");
  saveSettings({ ...loadSettings(), leaderboardEnabled: true });
  startLeaderboard();
  await vi.advanceTimersByTimeAsync(0);
  transport.emit(EVENT_RAW, "peer", peerStats);

  saveSettings({ ...loadSettings(), leaderboardName: "First" });
  await vi.advanceTimersByTimeAsync(1_000);
  saveSettings({ ...loadSettings(), leaderboardName: "Latest" });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(transport.sent()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(transport.sent()[2]).toEqual([null, expect.objectContaining({ name: "Latest" })]);

  await vi.advanceTimersByTimeAsync(57_000);
  expect(transport.sent()).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(119_999);
  expect(getLeaderboardState().peers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(getLeaderboardState().peers).toEqual([]);
});

it("ignores a superseded async join and reports an error key if the new room fails", async () => {
  const previous = fakeTransport(vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 100))));
  const current = fakeTransport(vi.fn(async () => { throw new Error("Join failed"); }));
  createAppNode.mockReturnValueOnce(previous.node).mockReturnValueOnce(current.node);
  setRoom("study");
  saveSettings({ ...loadSettings(), leaderboardEnabled: true });
  startLeaderboard();
  await vi.advanceTimersByTimeAsync(0);
  expect(previous.node.joinRoom).toHaveBeenCalledWith("study");
  expect(getLeaderboardState().status).toBe("connecting");

  setRoom("new-study");
  await vi.advanceTimersByTimeAsync(0);
  expect(previous.node.leaveRoom).toHaveBeenCalledOnce();
  expect(current.node.joinRoom).toHaveBeenCalledWith("new-study");
  expect(current.node.leaveRoom).toHaveBeenCalledOnce();
  expect(getLeaderboardState()).toMatchObject({
    status: "error", roomId: "new-study", error: "history-leaderboard-error-connect", peers: [],
  });
  previous.emit(EVENT_RAW, "peer", peerStats);
  await vi.advanceTimersByTimeAsync(100);
  expect(previous.sent()).toEqual([]);
  expect(getLeaderboardState()).toMatchObject({ status: "error", peers: [] });
});
