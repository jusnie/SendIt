// Direct WebRTC file transfer between browsers, using the Via server only as a
// signaling relay. If the server doesn't support /v1/rtc/* (or the peer is not
// reachable), the caller falls back to a normal server upload — sending always works.
import { call } from './api.js';

/**
 * Try to send `file` directly to devices `to` over a WebRTC data channel.
 * Resolves true if the peer accepted and received it, false otherwise (fall back).
 */
export function sendFileDirect(cfg, file, to, timeoutMs = 10000) {
  return new Promise(async (resolve) => {
    let pc;
    const timer = setTimeout(() => { try { pc?.close(); } catch {} resolve(false); }, timeoutMs);
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
      const channel = pc.createDataChannel('file');
      channel.onopen = () => {
        const header = JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' });
        channel.send(header);
        file.stream().pipeTo(new WritableStream({
          write(chunk) { channel.send(chunk); },
          close() { /* receiver closes after size reached */ },
        })).catch(() => {});
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) call(cfg.server, '/v1/rtc/candidate', { token: cfg.token, method: 'POST', json: { to, candidate: e.candidate.toJSON() } }).catch(() => {});
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Wait for ICE gathering to finish so the SDP is complete.
      await new Promise((r) => {
        if (pc.iceGatheringState === 'complete') return r();
        pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r());
        setTimeout(r, 1500);
      });
      await call(cfg.server, '/v1/rtc/offer', { token: cfg.token, method: 'POST', json: { to, sdp: pc.localDescription.toJSON() } });
      // Poll for the answer.
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 800));
        const ans = await call(cfg.server, `/v1/rtc/answer?to=${encodeURIComponent(to.join(','))}`, { token: cfg.token }).catch(() => null);
        if (ans?.sdp) {
          await pc.setRemoteDescription(ans.sdp);
          pc.addEventListener('datachannel', () => {});
          // Wait for the channel to open on the sender side.
          await new Promise((r) => {
            if (channel.readyState === 'open') return r();
            channel.addEventListener('open', r);
            setTimeout(r, 3000);
          });
          if (channel.readyState !== 'open') break;
          // Consider it sent once the peer acks via the server.
          const done = await call(cfg.server, `/v1/rtc/done?to=${encodeURIComponent(to.join(','))}`, { token: cfg.token }).catch(() => null);
          clearTimeout(timer);
          try { pc.close(); } catch {}
          return resolve(Boolean(done?.ok));
        }
      }
      clearTimeout(timer);
      try { pc.close(); } catch {}
      resolve(false);
    } catch {
      clearTimeout(timer);
      try { pc?.close(); } catch {}
      resolve(false);
    }
  });
}

/**
 * Receiver side: answer an incoming offer and save the file once the data
 * channel delivers the full payload. Called from the background on 'rtc-offer'.
 */
export function answerOffer(cfg, { from, sdp }, onSaved) {
  return new Promise(async (resolve) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
      pc.onicecandidate = (e) => {
        if (e.candidate) call(cfg.server, '/v1/rtc/candidate', { token: cfg.token, method: 'POST', json: { to: [from], candidate: e.candidate.toJSON() } }).catch(() => {});
      };
      let header = null;
      const chunks = [];
      let received = 0;
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        ch.onmessage = (m) => {
          if (!header) {
            header = JSON.parse(m.data);
            return;
          }
          const u8 = m.data instanceof ArrayBuffer ? new Uint8Array(m.data) : new Uint8Array(m.data.buffer ?? m.data);
          chunks.push(u8);
          received += u8.length;
          if (header.size && received >= header.size) {
            ch.close();
            const blob = new Blob(chunks, { type: header.type });
            onSaved?.(new File([blob], header.name, { type: header.type }));
            resolve(true);
          }
        };
      };
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await call(cfg.server, '/v1/rtc/answer', { token: cfg.token, method: 'POST', json: { to: [from], sdp: pc.localDescription.toJSON() } });
      setTimeout(() => resolve(false), 30000);
    } catch {
      resolve(false);
    }
  });
}
