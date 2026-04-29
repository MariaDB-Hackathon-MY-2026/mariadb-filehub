const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function embedText(text) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding; // float32[1536]
}

async function describeImage(buffer, mimeType) {
  const b64 = buffer.toString('base64');
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } },
        { type: 'text', text: 'Describe this image concisely in 2-3 sentences.' },
      ],
    }],
  });
  return res.choices[0].message.content;
}

async function transcribeAudio(buffer, filename) {
  const { toFile } = require('openai');
  const file = await toFile(buffer, filename);
  const res = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file,
  });
  return res.text;
}

module.exports = { embedText, describeImage, transcribeAudio };
