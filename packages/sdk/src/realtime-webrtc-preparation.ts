/** A local offer: no microphone, provider request, or session ownership. */
export type PreparedRealtimeWebrtc = {
  claim(): {
    peerConnection: RTCPeerConnection;
    events: RTCDataChannel;
    sender: RTCRtpSender | null;
    sdp: string | null;
  };
  stop(): void;
};

export async function prepareRealtimeWebrtc(options: {
  createPeerConnection(): RTCPeerConnection;
  signal: AbortSignal;
}): Promise<PreparedRealtimeWebrtc> {
  const check = () => {
    if (options.signal.aborted)
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  };
  check();
  const peerConnection = options.createPeerConnection();
  let events: RTCDataChannel | null = null;
  let retired = false;
  const stop = () => {
    if (retired) return;
    retired = true;
    options.signal.removeEventListener("abort", stop);
    try {
      events?.close();
    } finally {
      peerConnection.close();
    }
  };
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    events = peerConnection.createDataChannel("oai-events");
    // Older/custom hosts reuse the peer/channel but create SDP after capture.
    const sender =
      typeof peerConnection.addTransceiver === "function"
        ? peerConnection.addTransceiver("audio", { direction: "sendrecv" }).sender
        : null;
    let sdp: string | null = null;
    if (sender) {
      const offer = await peerConnection.createOffer();
      check();
      if (offer.type !== "offer" || !offer.sdp)
        throw Error("Browser did not create a WebRTC SDP offer");
      await peerConnection.setLocalDescription(offer);
      check();
      sdp = offer.sdp;
    }
    return {
      claim() {
        if (retired) throw new DOMException("Prepared WebRTC offer was retired", "AbortError");
        retired = true;
        options.signal.removeEventListener("abort", stop);
        return {
          peerConnection,
          events: events!,
          sender,
          sdp: peerConnection.localDescription?.sdp ?? sdp,
        };
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
