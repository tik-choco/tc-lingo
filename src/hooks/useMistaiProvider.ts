// App-local fork of @tik-choco/mistai/preact's useNetworkProvider (v0.4.x),
// with two additions the upstream hook lacks:
//
// 1. When the advertised capability set (provider_hello's services/models)
//    changes while the room session is live, the fresh provider_hello is
//    re-broadcast in place. The upstream hook only sends hello on join /
//    peer-connect / consumer_hello, and its room-join effect only re-runs on
//    enabled/roomId (everything else rides in a ref) - so share-list edits
//    would either never reach already-connected consumers, or require a
//    disruptive leave/rejoin (dropping in-flight requests) to propagate.
//    Consumers apply provider_hello updates mid-session (see ConsumerClient's
//    onMessage -> emitTableStatus), so the re-broadcast is all that's needed.
// 2. The hook speaks the extended wire codec (ExtendedNetwork, see
//    '../lib/p2p/network') instead of the library's Network, so oai_* tunnel
//    messages (OpenAI-compatible HTTP-over-P2P, see '../lib/p2p/tunnel')
//    reach an injected handler instead of being silently dropped by the
//    library's decoder. It also advertises an `extraServices` list (e.g.
//    'oai') alongside the library-derived chat/tts/stt services.
//
// Everything else is a faithful port of the upstream hook. Drop this fork
// (and re-import from '@tik-choco/mistai/preact') once the library supports
// both of the above itself.
//
// Ported byte-for-byte from tc-translate's src/hooks/useMistaiProvider.ts
// (see tc-docs/drafts/llm-settings-common-v1.md §4.3/§4.6). This app has no
// STT, but the fork stays generic (transcribe simply stays undefined at every
// call site) rather than special-casing that away.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  MistaiError,
  ProviderService,
  VoiceProviderService,
  type ProviderLogEntry,
  type ProtocolMessage,
} from '@tik-choco/mistai'
import {
  deriveHelloServices,
  routeProviderRequest,
  type NetworkProviderPeer,
  type NetworkProviderStatus,
  type UseNetworkProviderOptions,
  type UseNetworkProviderResult,
} from '@tik-choco/mistai/preact'
import { ExtendedNetwork } from '../lib/p2p/network'
import type { ExtendedMessage } from '../lib/p2p/protocol'

/** Return shape of `createTunnelProvider` (see `OaiTunnelProvider` in `../lib/p2p/tunnel`). */
export interface OaiTunnelHandler {
  handleMessage(fromId: string, msg: ExtendedMessage): boolean
  dropPeer(peerId: string): void
}

export interface UseNetworkProviderOptionsExtended extends UseNetworkProviderOptions {
  /** Extra service names appended to provider_hello.services (e.g. 'oai'). */
  extraServices?: string[]
  /** Per-session factory for the oai tunnel handler; created alongside ProviderService inside the join effect. */
  createTunnelProvider?: (send: (toId: string, msg: ExtendedMessage) => void) => OaiTunnelHandler
}

export function useMistaiNetworkProvider(options: UseNetworkProviderOptionsExtended): UseNetworkProviderResult {
  const [status, setStatus] = useState<NetworkProviderStatus>('idle')
  const [statusUpdatedAt, setStatusUpdatedAt] = useState(() => Date.now())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [peers, setPeers] = useState<NetworkProviderPeer[]>([])
  const [logs, setLogs] = useState<ProviderLogEntry[]>([])
  const [ownNodeId, setOwnNodeId] = useState<string | null>(null)
  const maxLogEntries = options.maxLogEntries ?? 50

  function updateStatus(next: NetworkProviderStatus): void {
    setStatus((current) => {
      if (current !== next) setStatusUpdatedAt(Date.now())
      return next
    })
  }

  // Everything but enabled/roomId rides in refs so upstream-function identity
  // changes don't tear down and rejoin the room on every render.
  const optionsRef = useRef(options)
  optionsRef.current = options
  const networkRef = useRef<ExtendedNetwork | null>(null)
  const providerServiceRef = useRef<ProviderService | null>(null)
  const voiceProviderServiceRef = useRef<VoiceProviderService | null>(null)
  const tunnelProviderRef = useRef<OaiTunnelHandler | null>(null)
  const enabled = options.enabled
  const roomId = options.roomId.trim()
  const consumerCount = useMemo(() => peers.filter((peer) => peer.isConsumer).length, [peers])

  // Reads the latest options at send time, so the join broadcast, the
  // per-peer hellos, and the live re-broadcast below all advertise the same,
  // current capability set.
  function helloMessage() {
    const opts = optionsRef.current
    const services = [...deriveHelloServices(opts), ...(opts.extraServices ?? [])]
    const models = opts.advertisedModels
    return {
      v: 1 as const,
      type: 'provider_hello' as const,
      services,
      ...(models && models.length > 0 ? { models } : {}),
    }
  }

  useEffect(() => {
    if (!enabled || !roomId) {
      networkRef.current?.destroy()
      networkRef.current = null
      providerServiceRef.current = null
      voiceProviderServiceRef.current = null
      tunnelProviderRef.current = null
      updateStatus('idle')
      setErrorMessage(null)
      setPeers([])
      return
    }

    let cancelled = false
    updateStatus('connecting')
    setErrorMessage(null)
    setPeers([])
    setLogs([])
    const cap = optionsRef.current.maxLogEntries ?? 50
    const pushLog = (entry: ProviderLogEntry): void => {
      setLogs((current) => {
        const withoutEntry = current.filter((logEntry) => logEntry.id !== entry.id)
        return [entry, ...withoutEntry].slice(0, cap)
      })
    }

    const sendToNetwork = (toId: string | null, msg: ExtendedMessage): void => network.send(toId, msg)
    const network = new ExtendedNetwork({
      createNode: (nodeId) => optionsRef.current.createNode(nodeId),
      nodeIdStorageKey: optionsRef.current.nodeIdStorageKey,
      callbacks: {
        onPeerConnected: (peerId) => {
          setPeers((current) =>
            current.some((peer) => peer.nodeId === peerId)
              ? current
              : [...current, { nodeId: peerId, connectedAt: Date.now(), isConsumer: false }],
          )
          // A newly connected peer might be a consumer looking for us — announce ourselves.
          network.send(peerId, helloMessage())
        },
        onPeerDisconnected: (peerId) => {
          setPeers((current) => current.filter((peer) => peer.nodeId !== peerId))
          voiceProviderServiceRef.current?.dropPeer(peerId)
          tunnelProviderRef.current?.dropPeer(peerId)
        },
        onMessage: (fromId, msg) => {
          // oai_* tunnel messages (OpenAI-compatible HTTP-over-P2P) are fully
          // owned by the tunnel handler; everything else below is a library
          // ProtocolMessage.
          if (tunnelProviderRef.current?.handleMessage(fromId, msg)) return
          if (msg.type === 'consumer_hello') {
            setPeers((current) => {
              const existing = current.find((peer) => peer.nodeId === fromId)
              if (existing) {
                return current.map((peer) => (peer.nodeId === fromId ? { ...peer, isConsumer: true } : peer))
              }
              return [...current, { nodeId: fromId, connectedAt: Date.now(), isConsumer: true }]
            })
            network.send(fromId, helloMessage())
            return
          }
          routeProviderRequest(fromId, msg as ProtocolMessage /* tunnel already consumed oai_* above */, {
            providerService: providerServiceRef.current,
            voiceProviderService: voiceProviderServiceRef.current,
            send: sendToNetwork,
          })
        },
      },
    })

    const providerService = optionsRef.current.callLlm
      ? new ProviderService(
          sendToNetwork,
          (messages, model, onDelta) => {
            const fn = optionsRef.current.callLlm
            if (!fn) throw new MistaiError('ENDPOINT_NOT_CONFIGURED', 'This provider has no LLM endpoint configured.')
            return fn(messages, model, onDelta)
          },
          { onRequestLog: pushLog, maxLogEntries: cap },
        )
      : null
    const hasVoice = Boolean(optionsRef.current.synthesize || optionsRef.current.transcribe)
    const voiceProviderService = hasVoice
      ? new VoiceProviderService(
          sendToNetwork,
          async (text, model, voice) => {
            const fn = optionsRef.current.synthesize
            if (!fn) throw new MistaiError('ENDPOINT_NOT_CONFIGURED', 'This provider has no TTS endpoint configured.')
            return fn(text, model, voice)
          },
          async (audio, mime, model, fileName) => {
            const fn = optionsRef.current.transcribe
            if (!fn) throw new MistaiError('ENDPOINT_NOT_CONFIGURED', 'This provider has no STT endpoint configured.')
            return fn(audio, mime, model, fileName)
          },
          { onRequestLog: pushLog },
        )
      : null
    const tunnelProvider = optionsRef.current.createTunnelProvider?.(sendToNetwork) ?? null

    networkRef.current = network
    providerServiceRef.current = providerService
    voiceProviderServiceRef.current = voiceProviderService
    tunnelProviderRef.current = tunnelProvider
    setOwnNodeId(network.id)
    network
      .join(roomId)
      .then(() => {
        if (cancelled) return
        updateStatus('connected')
        // Announce presence to anyone already in the room.
        network.send(null, helloMessage())
      })
      .catch((err) => {
        if (cancelled) return
        updateStatus('error')
        setErrorMessage(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      network.destroy()
      if (networkRef.current === network) networkRef.current = null
      if (providerServiceRef.current === providerService) providerServiceRef.current = null
      if (voiceProviderServiceRef.current === voiceProviderService) voiceProviderServiceRef.current = null
      if (tunnelProviderRef.current === tunnelProvider) tunnelProviderRef.current = null
    }
  }, [enabled, roomId])

  // --- fork addition ---------------------------------------------------------
  // Re-broadcast provider_hello, without leaving the room, whenever what it
  // would announce (services + extraServices + advertised models) changes on
  // a live session. Joining/connecting sessions are skipped: their own join
  // broadcast reads the latest options from the ref anyway.
  const helloKey = `${deriveHelloServices(options).join(',')}|${(options.extraServices ?? []).join(',')}|${(options.advertisedModels ?? []).join('\n')}`
  const helloKeyRef = useRef(helloKey)
  useEffect(() => {
    if (helloKeyRef.current === helloKey) return
    helloKeyRef.current = helloKey
    if (status !== 'connected') return
    networkRef.current?.send(null, helloMessage())
  }, [helloKey, status])

  return {
    status,
    statusUpdatedAt,
    errorMessage,
    peers,
    peerCount: peers.length,
    consumerCount,
    logs: logs.slice(0, maxLogEntries),
    ownNodeId,
    roomId,
  }
}
