"use client";

/**
 * Full-mesh peer-to-peer WebRTC (2 players for 1v1, 4 for Duo).
 * Signaling rides on the game socket; media flows directly between browsers.
 * Deterministic initiator rule: the lexicographically smaller player id
 * creates the offer, so exactly one offer exists per pair.
 */

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export interface SignalPayload {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit | null;
}

export class MeshRTC {
  private peers = new Map<string, RTCPeerConnection>();
  private stream: MediaStream | null = null;
  closed = false;

  constructor(
    public myId: string,
    private sendSignal: (to: string, data: SignalPayload) => void,
    private onRemoteTrack: (fromId: string, stream: MediaStream) => void,
    private onPeerState?: (fromId: string, state: RTCPeerConnectionState) => void
  ) {}

  setLocalStream(stream: MediaStream) {
    this.stream = stream;
    for (const pc of this.peers.values()) {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    }
  }

  private ensurePeer(remoteId: string): RTCPeerConnection {
    let pc = this.peers.get(remoteId);
    if (pc) return pc;
    pc = new RTCPeerConnection(RTC_CONFIG);
    this.peers.set(remoteId, pc);

    if (this.stream) {
      for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignal(remoteId, { ice: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      if (stream) this.onRemoteTrack(remoteId, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc) this.onPeerState?.(remoteId, pc.connectionState);
    };
    return pc;
  }

  /** Call once per remote peer after match_found. */
  async openPeer(remoteId: string): Promise<void> {
    const pc = this.ensurePeer(remoteId);
    const iAmInitiator = this.myId < remoteId;
    if (!iAmInitiator) return; // wait for the offer
    if (pc.signalingState !== "stable") return;
    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    this.sendSignal(remoteId, { sdp: { type: offer.type, sdp: offer.sdp } });
  }

  async handleSignal(from: string, data: SignalPayload): Promise<void> {
    const pc = this.ensurePeer(from);
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendSignal(from, { sdp: { type: answer.type, sdp: answer.sdp } });
        }
      } else if (data.ice) {
        await pc.addIceCandidate(new RTCIceCandidate(data.ice));
      }
    } catch (err) {
      // ICE races are normal; log but never crash the battle over them.
      console.warn("[rtc] signal handling warning", err);
    }
  }

  close() {
    this.closed = true;
    for (const pc of this.peers.values()) {
      try {
        pc.close();
      } catch {
        /* noop */
      }
    }
    this.peers.clear();
  }
}
