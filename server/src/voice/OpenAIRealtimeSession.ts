import WebSocket from 'ws';

interface RealtimeSessionCallbacks {
  onInputTranscript: (transcript: string, itemId: string | null) => void;
  onAudioDelta: (audio: Buffer) => void;
  onOutputTranscript: (transcript: string) => void;
  onResponseDone: () => void;
  onError: (message: string) => void;
  onClose: (code: number, reason: string) => void;
}

export class OpenAIRealtimeSession {
  private socket: WebSocket | null = null;
  private outputTranscript = '';

  constructor(
    private readonly model: string,
    private readonly voice: string,
    private readonly instructions: string,
    private readonly safetyIdentifier: string,
    private readonly callbacks: RealtimeSessionCallbacks
  ) {}

  async connect(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Safety-Identifier': this.safetyIdentifier,
      },
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    socket.on('message', data => this.handleEvent(data.toString()));
    socket.on('error', error => this.callbacks.onError(error.message));
    socket.on('close', (code, reason) => {
      const text = reason.toString();
      this.callbacks.onClose(code, text);
      if (text.length > 0) this.callbacks.onError(text);
    });
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.model,
        output_modalities: ['audio'],
        instructions: this.instructions,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: null,
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: this.voice,
          },
        },
      },
    });
  }

  appendAudio(pcm24KhzMono: Buffer): void {
    this.send({
      type: 'input_audio_buffer.append',
      audio: pcm24KhzMono.toString('base64'),
    });
  }

  commitInput(): void {
    this.outputTranscript = '';
    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'response.create' });
  }

  clearInput(): void {
    this.send({ type: 'input_audio_buffer.clear' });
  }

  interrupt(): void {
    this.send({ type: 'response.cancel' });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  private handleEvent(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event.type ?? '');
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(event.transcript ?? '').trim();
      if (transcript) {
        this.callbacks.onInputTranscript(
          transcript,
          typeof event.item_id === 'string' ? event.item_id : null
        );
      }
      return;
    }
    if (type === 'response.output_audio.delta' && typeof event.delta === 'string') {
      this.callbacks.onAudioDelta(Buffer.from(event.delta, 'base64'));
      return;
    }
    if (
      type === 'response.output_audio_transcript.delta' &&
      typeof event.delta === 'string'
    ) {
      this.outputTranscript += event.delta;
      return;
    }
    if (type === 'response.output_audio_transcript.done') {
      const transcript = String(event.transcript ?? this.outputTranscript).trim();
      if (transcript) this.callbacks.onOutputTranscript(transcript);
      return;
    }
    if (type === 'response.done') {
      this.callbacks.onResponseDone();
      return;
    }
    if (type === 'error') {
      const error = event.error as { message?: string } | undefined;
      this.callbacks.onError(error?.message ?? 'OpenAI Realtime session failed');
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('OpenAI Realtime socket is not open');
    }
    this.socket.send(JSON.stringify(event));
  }
}
