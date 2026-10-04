import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { spawn } from 'child_process';

let ffmpegPath = process.env.FFMPEG_PATH;
if (!ffmpegPath) {
  try {
    ffmpegPath = (await import('ffmpeg-static')).default;
  } catch {
    ffmpegPath = 'ffmpeg'; // system ffmpeg (Termux: pkg install ffmpeg)
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/\D/g, ''); // country code ke saath, + ke bina
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || 'Kore';
const AUTH_DIR = process.env.AUTH_DIR || 'auth';

const VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];
const voiceMap = Object.fromEntries(VOICES.map((v) => [v.toLowerCase(), v]));

// ---- Gemini TTS -> raw PCM (24kHz, 16-bit, mono)
async function geminiTTS(text, voiceName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
    }),
  });
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}`);
    err.status = res.status;
    err.body = await res.text();
    throw err;
  }
  const data = await res.json();
  const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error('Audio nahi mila response me');
  return Buffer.from(b64, 'base64');
}

// ---- PCM -> OGG/Opus (WhatsApp voice note format)
function pcmToOpus(pcm) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1',
    ]);
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('ffmpeg fail ' + code))
    );
    ff.stdin.on('error', () => {});
    ff.stdin.end(pcm);
  });
}

// ---- Command parse: "~ text", "~Kore text", "^ Puck text"
function parseCommand(body) {
  const t = body.trim();
  if (!t.startsWith('~') && !t.startsWith('^')) return null;
  let rest = t.slice(1).trim();
  if (/^(voices|list)$/i.test(rest)) return { list: true };
  let voice = DEFAULT_VOICE;
  const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
  if (m && voiceMap[m[1].toLowerCase().replace(/[:|,]$/, '')]) {
    voice = voiceMap[m[1].toLowerCase().replace(/[:|,]$/, '')];
    rest = m[2].trim();
  } else if (voiceMap[rest.toLowerCase()]) {
    return { list: true };
  }
  if (!rest) return null;
  return { voice, text: rest };
}

function isSelfChat(sock, jid) {
  const user = (j) => (j || '').split('@')[0].split(':')[0];
  const target = user(jid);
  return target === user(sock.user?.id) || (sock.user?.lid && target === user(sock.user.lid));
}

async function start() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY set karo');
  if (!PHONE_NUMBER) throw new Error('PHONE_NUMBER set karo (jaise 919XXXXXXXXX)');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
  });

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('\n=== PAIRING CODE:', code, '===');
        console.log('WhatsApp > Linked devices > Link with phone number me ye code daalo\n');
      } catch (e) {
        console.error('Pairing code error:', e.message);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') console.log('WhatsApp connected');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out. auth folder delete karke dobara pair karo.');
      } else {
        console.log('Reconnecting...');
        start();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        if (!m.message || !m.key.fromMe) return;
        const jid = m.key.remoteJid;
        if (!isSelfChat(sock, jid)) continue;

        const body = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const cmd = parseCommand(body);
        if (!cmd) continue;

        if (cmd.list) {
          await sock.sendMessage(jid, {
            text: `Voices (${VOICES.length}):\n${VOICES.join(', ')}\n\nUse: ~Kore tumhara text`,
          });
          continue;
        }

        await sock.sendPresenceUpdate('recording', jid);
        const pcm = await geminiTTS(cmd.text, cmd.voice);
        const opus = await pcmToOpus(pcm);
        await sock.sendMessage(jid, {
          audio: opus,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        });
        await sock.sendPresenceUpdate('paused', jid);
      } catch (e) {
        console.error('TTS error:', e.status || '', e.body || e.message);
        const msg =
          e.status === 429
            ? 'Rate limit lag gayi (free API). 1 minute baad try karo.'
            : 'Voice nahi ban payi: ' + e.message;
        await sock.sendMessage(m.key.remoteJid, { text: msg }).catch(() => {});
      }
    }
  });
}

start();
