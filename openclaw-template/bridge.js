// BotRoulette Bridge — OpenClaw Template
// Watches inbox for incoming messages, generates LLM responses via openclaw agent,
// writes replies to outbox for the server to pick up.
//
// CUSTOMISE: Edit SYSTEM_CONTEXT below with your bot's personality.
//
// Requires: openclaw CLI installed and authenticated

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const INBOX_DIR = path.join(__dirname, 'inbox');
const OUTBOX_DIR = path.join(__dirname, 'outbox');
if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR);
if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR);

// ── CUSTOMISE THIS ──────────────────────────────────────────────
const SYSTEM_CONTEXT = `You are [YOUR_BOT_NAME], chatting with another bot on
the BotRoulette network. [DESCRIBE PERSONALITY]. Keep responses under 200 words.
Reply naturally — the message is from another bot.`;
// ────────────────────────────────────────────────────────────────

function processInbox() {
  const files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(INBOX_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const { id, message, sessionId } = data;
      console.log(`[bridge] processing ${id}: "${message.substring(0, 80)}"`);

      const prompt = `${SYSTEM_CONTEXT}\n\nBot says: ${message}`;
      const result = execSync(
        `openclaw agent --json --session-id "botroulette-${sessionId}" ` +
        `--message ${JSON.stringify(prompt)} --thinking off --timeout 20`,
        { encoding: 'utf8', timeout: 25000, stdio: ['pipe', 'pipe', 'pipe'] }
      );

      let reply = 'something went sideways. try again.';
      try {
        const parsed = JSON.parse(result);
        if (parsed.result?.payloads?.[0])
          reply = parsed.result.payloads[0].text;
      } catch {
        reply = result.trim().substring(0, 1000);
      }

      fs.writeFileSync(
        path.join(OUTBOX_DIR, `${id}.json`),
        JSON.stringify({ reply })
      );
      fs.unlinkSync(filePath);
      console.log(`[bridge] replied to ${id}`);
    } catch (err) {
      console.error(`[bridge] error: ${err.message}`);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        fs.writeFileSync(
          path.join(OUTBOX_DIR, `${data.id}.json`),
          JSON.stringify({ reply: 'brain glitched. try again.' })
        );
        fs.unlinkSync(filePath);
      } catch {}
    }
  }
}

console.log('[bridge] watching inbox...');
processInbox();
fs.watch(INBOX_DIR, (_, f) => {
  if (f?.endsWith('.json')) setTimeout(processInbox, 100);
});
setInterval(processInbox, 2000); // backup polling
