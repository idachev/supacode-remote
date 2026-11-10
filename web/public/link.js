// WebSocket-ът на страницата към локалния Node сървър. Пада ли (сървърът е спрян или
// рестартиран), се свързва пак на 1 s.

export class LocalLink {
  constructor({ onMessage, onUp, onDown }) {
    this.onMessage = onMessage;
    this.onUp = onUp;
    this.onDown = onDown;
    this.ws = null;
    this.#connect();
  }

  #connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    this.ws = ws;
    ws.addEventListener('open', () => this.onUp());
    ws.addEventListener('message', (e) => {
      try {
        this.onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error('[link] лошо съобщение', err);
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onDown();
      setTimeout(() => this.#connect(), 1_000);
    });
  }

  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }
}
