export async function simulateTyping(sock, jid, text) {
  const readDelay = Math.floor(Math.random() * 2000) + 1500;
  await new Promise((r) => setTimeout(r, readDelay));

  await sock.sendPresenceUpdate('composing', jid);

  const charDelay = Math.min(Math.max(text.length * 40, 2000), 10000);
  await new Promise((r) => setTimeout(r, charDelay));

  await sock.sendPresenceUpdate('paused', jid);
}

